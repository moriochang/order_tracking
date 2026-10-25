// ocr-receipt：拍照辨識預購明細（Google Cloud Vision DOCUMENT_TEXT_DETECTION）
// 流程：驗證呼叫者是已開通的同仁 → 圖片送 Vision 辨識 → 回傳每個字詞與位置
//       （版面重組與欄位解析在瀏覽器進行，見 web/src/lib/ocrLayout.ts、receiptParser.ts）
// 圖片不儲存，只在這次請求中轉送給 Vision。
// 為了能直接在 Supabase Dashboard 貼上部署，本檔不依賴其他檔案（Google token 程式與 admin-users 相同）。
//
// 需要的 secrets：
//   FIREBASE_SERVICE_ACCOUNT  與 admin-users 共用；Vision 費用計入同一個 Google Cloud 專案
//   ALLOWED_ORIGINS           允許呼叫的網頁來源，逗號分隔
//   GOOGLE_VISION_API_KEY     （選用）設定時改用 API 金鑰呼叫 Vision
// 平台自動提供：SUPABASE_URL、SUPABASE_ANON_KEY

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
type Vertex = { x?: number; y?: number };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

let cachedToken: { token: string; exp: number } | null = null;

async function googleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
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
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: now + Number(json.expires_in ?? 3600) };
  return cachedToken.token;
}

// ── PostgREST（以呼叫者本人的 Firebase token） ───────────────────
async function rpc(callerToken: string, fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${callerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 400, json?.message ?? 'RPC_ERROR', json?.details ?? '');
  return json;
}

// ── Google Cloud Vision ──────────────────────────────────
async function recognize(imageBase64: string) {
  const apiKey = Deno.env.get('GOOGLE_VISION_API_KEY');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url = 'https://vision.googleapis.com/v1/images:annotate';
  if (apiKey) {
    url += `?key=${encodeURIComponent(apiKey)}`;
  } else {
    const sa: ServiceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? 'null');
    if (!sa?.private_key) throw new HttpError(500, 'SERVER_NOT_CONFIGURED');
    headers.Authorization = `Bearer ${await googleAccessToken(sa)}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requests: [{
        image: { content: imageBase64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['zh-Hant', 'en'] },
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error('vision error', res.status, JSON.stringify(json?.error ?? null));
    throw new HttpError(502, 'OCR_PROVIDER_ERROR', json?.error?.status ?? String(res.status));
  }
  const r = json?.responses?.[0];
  if (r?.error) throw new HttpError(502, 'OCR_PROVIDER_ERROR', r.error.message ?? '');

  // 字詞與四角座標（依文字方向：左上、右上、右下、左下）
  const words: { t: string; v: number[][] }[] = [];
  for (const page of r?.fullTextAnnotation?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? []) {
          const t = (word.symbols ?? []).map((s: { text: string }) => s.text).join('');
          const v = (word.boundingBox?.vertices ?? []).map((p: Vertex) => [p.x ?? 0, p.y ?? 0]);
          if (t && v.length === 4) words.push({ t, v });
        }
      }
    }
  }
  return { provider: 'google-vision', text: r?.fullTextAnnotation?.text ?? '', words };
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

    const body = await req.json().catch(() => null);
    const image = typeof body?.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
    if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new HttpError(400, 'VALIDATION', 'image');
    if (image.length * 0.75 > MAX_IMAGE_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE');

    const t0 = Date.now();
    const result = await recognize(image);
    console.log('ocr', me.user_id, `${Math.round(image.length * 0.75 / 1024)}KB`, `${Date.now() - t0}ms`, `${result.words.length} words`);
    return reply(200, result);
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { code: e.code, detail: e.detail });
    if ((e as Error)?.name === 'TimeoutError') return reply(504, { code: 'OCR_TIMEOUT' });
    console.error('ocr-receipt unexpected error', (e as Error).message);
    return reply(500, { code: 'INTERNAL' });
  }
});
