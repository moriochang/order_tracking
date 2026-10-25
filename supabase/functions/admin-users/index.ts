// admin-users：由 admin 建立同仁帳號
// 流程：驗證呼叫者是 admin → 建立 Firebase 帳號 → 設定 role: authenticated claim
//       → 以呼叫者身分呼叫 admin_create_user（寫入 profiles 與稽核）
// 設計依據 docs/design-phase1.md §2.1
//
// 需要的 secrets（supabase secrets set ...）：
//   FIREBASE_SERVICE_ACCOUNT  Firebase 服務帳戶金鑰 JSON 全文
//   ALLOWED_ORIGINS           允許呼叫的網頁來源，逗號分隔，例如 https://moriochang.github.io
// 平台自動提供：SUPABASE_URL、SUPABASE_ANON_KEY

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ROLES = ['staff', 'manager', 'admin'];

class HttpError extends Error {
  constructor(public status: number, public code: string, public detail = '') {
    super(code);
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

// ── Google 服務帳戶 → OAuth access token ─────────────────────
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function googleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new HttpError(500, 'GOOGLE_AUTH_FAILED', await res.text());
  return (await res.json()).access_token;
}

// ── Firebase Auth Admin REST ──────────────────────────────
async function firebase(sa: ServiceAccount, token: string, path: string, body: unknown) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new HttpError(400, json?.error?.message ?? 'FIREBASE_ERROR');
  return json;
}

// ── PostgREST（以呼叫者本人的 Firebase token） ───────────────────
async function rpc(callerToken: string, fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${callerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 400, json?.message ?? 'RPC_ERROR', json?.details ?? '');
  return json;
}

async function createUser(callerToken: string, input: Record<string, unknown>) {
  const email = String(input.email ?? '').trim().toLowerCase();
  // 顯示名稱預設為 Email @ 前段（由資料庫帶入）
  const displayName = String(input.display_name ?? '').trim() || email.split('@')[0];
  const role = String(input.role ?? 'staff');
  const storeCodes = Array.isArray(input.store_codes) ? input.store_codes.map(String) : [];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'VALIDATION', 'email');
  if (!ROLES.includes(role)) throw new HttpError(400, 'VALIDATION', 'role');

  const sa: ServiceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? 'null');
  if (!sa?.private_key) throw new HttpError(500, 'SERVER_NOT_CONFIGURED');
  const gToken = await googleAccessToken(sa);

  // 預先建立 Firebase 帳號（因為已關閉自行註冊）；同仁之後用同一個 Email 的 Google 帳號登入。
  // 已存在的帳號（例如先前建立到一半，或同仁已登入過）直接沿用。
  let created = false;
  let uid: string;
  const lookup = await firebase(sa, gToken, 'accounts:lookup', { email: [email] });
  if (lookup.users?.length) {
    uid = lookup.users[0].localId;
  } else {
    uid = (await firebase(sa, gToken, 'accounts', { email, displayName, emailVerified: true })).localId;
    created = true;
  }
  await firebase(sa, gToken, 'accounts:update', {
    localId: uid,
    emailVerified: true,
    customAttributes: JSON.stringify({ role: 'authenticated' }),
  });

  try {
    const result = await rpc(callerToken, 'admin_create_user', {
      p_auth_uid: uid, p_email: email, p_display_name: displayName, p_role: role, p_store_codes: storeCodes,
    });
    return { ...result, email };
  } catch (e) {
    // 資料庫寫入失敗時移除剛建立的 Firebase 帳號，避免留下無用帳號
    if (created) await firebase(sa, gToken, 'accounts:delete', { localId: uid }).catch(() => {});
    throw e;
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const callerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!callerToken) throw new HttpError(401, 'UNAUTHENTICATED');

    const me = await rpc(callerToken, 'get_me', {});
    if (!me) throw new HttpError(401, 'UNAUTHENTICATED');
    if (me.role !== 'admin') throw new HttpError(403, 'FORBIDDEN');

    const body = await req.json();
    if (body?.action === 'create') return reply(200, await createUser(callerToken, body));
    throw new HttpError(400, 'VALIDATION', 'action');
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { code: e.code, detail: e.detail });
    console.error('admin-users unexpected error', (e as Error).message);
    return reply(500, { code: 'INTERNAL' });
  }
});
