// sync-sheet：把全部訂單整份寫入 Google 試算表（欄位與網頁「匯出」報表相同，每台單機一列）。
// 由 Supabase Cron 每 10 分鐘呼叫（scripts/sheet-sync/schedule.sql）；單向同步，試算表上的修改會在下次同步被覆蓋。
// 每次整份重寫：某次失敗時，下一次會補齊。先寫新資料、再清掉多出來的舊列，同步中不會看到空白表。
// 每天 22:10 另以 {"mode":"verify"} 呼叫：先比對資料庫與試算表、把結果記在「每日核對」分頁，再重新同步。
// 為了能直接在 Supabase Dashboard 貼上部署，本檔不依賴其他檔案（Google token 程式與 ocr-receipt 相同）。
//
// 需要的 secrets：
//   FIREBASE_SERVICE_ACCOUNT  與 admin-users、ocr-receipt 共用；試算表要分享給這個服務帳戶（編輯者）
//   SHEET_ID                  試算表網址 /d/ 與 /edit 之間那一段
//   SYNC_SECRET               Cron 呼叫時帶的密語（x-sync-secret），與 Vault 的 sheet_sync_secret 相同
// 平台自動提供：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（只用來呼叫唯讀的 sheet_sync_data()）

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
type Order = {
  id: string; order_no: string; store_code: string; customer_name: string; customer_phone: string; purchase_date: string;
  register_no: string; receipt_seq: string; receipt_no: string | null; order_note: string | null; order_status: string;
};
type Item = { item_id: string; order_id: string; full_product_name: string; model: string | null; barcode: string | null };
type Device = {
  order_id: string; order_item_id: string; unit_no: number; sn: string | null; status: string; is_labeled: boolean;
  arrived_at: string | null; last_notified_at: string | null; delivered_at: string | null; note: string | null;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DATA_TAB = '預購訂單';
const INFO_TAB = '同步時間';
const CHECK_TAB = '每日核對';
const CHECK_HEADER = ['核對時間', '系統列數', '試算表列數', '結果', '不同的訂單編號（最多 20 筆）', '處理'];

// 與 web/src/lib/exportOrders.ts、labels.ts 相同
const HEADER = ['訂單編號', '門市', '顧客', '電話', '結帳日期', '機號', '序號', '預結號碼', '品名', '型號', '國際條碼',
  'SN', '狀態', '已貼', '到貨時間', '最近通知', '取貨時間', '單機備註', '訂單備註'];
const STATUS_LABEL: Record<string, string> = {
  pending_arrival: '待到貨', arrived_pending_notify: '已到貨', notified_pending_pickup: '已通知',
  delivered: '已取貨', excluded: '已取走／不追蹤', cancelled: '已取消',
};

class HttpError extends Error {
  constructor(public status: number, public code: string, public detail = '') {
    super(code);
  }
}

const dateTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtDateTime = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '');
const fmtDate = (d: string | null) => (d ? d.replaceAll('-', '/') : '');


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
    scope: 'https://www.googleapis.com/auth/spreadsheets',
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

// ── 讀取資料：資料庫函式 sheet_sync_data()（只開放給 service_role，唯讀） ───────────
async function loadData(): Promise<{ orders: Order[]; items: Item[]; devices: Device[] }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sheet_sync_data`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new HttpError(500, 'DB_READ_FAILED', await res.text());
  return await res.json();
}

async function buildRows(): Promise<string[][]> {
  const { orders, items, devices } = await loadData();
  const itemIndex = new Map(items.map((it, i) => [it.item_id, i]));
  const devsByOrder = new Map<string, Device[]>();
  for (const d of devices) {
    if (!itemIndex.has(d.order_item_id)) continue;
    const list = devsByOrder.get(d.order_id) ?? [];
    list.push(d);
    devsByOrder.set(d.order_id, list);
  }
  const rows: string[][] = [HEADER];
  for (const o of orders) {
    const head = [o.order_no, o.store_code, o.customer_name, o.customer_phone, fmtDate(o.purchase_date),
      o.register_no, o.receipt_seq, o.receipt_no ?? ''];
    const devs = (devsByOrder.get(o.id) ?? [])
      .sort((a, b) => itemIndex.get(a.order_item_id)! - itemIndex.get(b.order_item_id)! || a.unit_no - b.unit_no);
    if (o.order_status === 'cancelled' || !devs.length) {
      rows.push([...head, '', '', '', '', '已取消', '', '', '', '', '', o.order_note ?? '']);
      continue;
    }
    for (const d of devs) {
      const it = items[itemIndex.get(d.order_item_id)!];
      rows.push([...head, it.full_product_name, it.model ?? '', it.barcode ?? '', d.sn ?? '', STATUS_LABEL[d.status] ?? d.status,
        d.is_labeled ? '是' : '', fmtDateTime(d.arrived_at), fmtDateTime(d.last_notified_at), fmtDateTime(d.delivered_at),
        d.note ?? '', o.order_note ?? '']);
    }
  }
  return rows.map((r) => r.map((v) => String(v ?? '')));
}

// ── Google 試算表 ─────────────────────────────────────────
async function sheets(token: string, sheetId: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, 'SHEETS_ERROR', `${res.status} ${json?.error?.status ?? ''} ${json?.error?.message ?? ''}`);
  return json;
}

const tab = (t: string) => `'${t}'`;

async function openSheet() {
  const sheetId = Deno.env.get('SHEET_ID');
  const sa: ServiceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? 'null');
  if (!sheetId || !sa?.private_key) throw new HttpError(500, 'SERVER_NOT_CONFIGURED');
  const token = await googleAccessToken(sa);
  const call = (path: string, method: string, body?: unknown) => sheets(token, sheetId, path, method, body);

  // 第一次使用時建立分頁
  const meta = await call('?fields=sheets.properties.title', 'GET');
  const titles = new Set((meta.sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title));
  const add = [DATA_TAB, INFO_TAB, CHECK_TAB].filter((t) => !titles.has(t)).map((title) => ({ addSheet: { properties: { title } } }));
  if (add.length) await call(':batchUpdate', 'POST', { requests: add });
  if (!titles.has(CHECK_TAB)) {
    await call(`/values/${encodeURIComponent(`${tab(CHECK_TAB)}!A1`)}?valueInputOption=RAW`, 'PUT', { values: [CHECK_HEADER] });
  }
  return call;
}

type SheetCall = Awaited<ReturnType<typeof openSheet>>;

async function writeSheet(call: SheetCall, rows: string[][]) {
  await call('/values:batchUpdate', 'POST', {
    valueInputOption: 'RAW',  // 一律當文字：機號、電話開頭的 0 與國際條碼不會被改掉，= 開頭也不會變成公式
    data: [
      { range: `${tab(DATA_TAB)}!A1`, values: rows },
      { range: `${tab(INFO_TAB)}!A1`, values: [
        ['最後同步', fmtDateTime(new Date().toISOString())],
        ['列數', String(rows.length - 1)],
        ['說明', '由預購商品追蹤系統每 10 分鐘自動更新；在這裡修改會被覆蓋，請到系統修改。每天 22:10 核對一次，結果在「每日核對」分頁。'],
      ] },
    ],
  });
  await call(`/values/${encodeURIComponent(`${tab(DATA_TAB)}!A${rows.length + 1}:Z`)}:clear`, 'POST', {});
}

// 每日核對：逐列比對（同一內容出現幾次也要相同），回傳不同的訂單編號
async function compareSheet(call: SheetCall, rows: string[][]) {
  const got = await call(`/values/${encodeURIComponent(`${tab(DATA_TAB)}!A1:Z`)}`, 'GET');
  const width = HEADER.length;
  const norm = (r: unknown[]) => JSON.stringify(Array.from({ length: width }, (_, i) => String(r[i] ?? '')));
  const sheetRows: unknown[][] = (got.values ?? []).filter((r: unknown[]) => r.some((v) => String(v ?? '') !== ''));
  const count = new Map<string, number>();
  for (const r of rows) count.set(norm(r), (count.get(norm(r)) ?? 0) + 1);
  for (const r of sheetRows) count.set(norm(r), (count.get(norm(r)) ?? 0) - 1);
  const diff = new Set<string>();
  for (const [k, n] of count) if (n !== 0) diff.add(JSON.parse(k)[0] || '（空白訂單編號）');
  return { sheetRows: sheetRows.length - 1, diff: [...diff].sort() };
}

Deno.serve(async (req) => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const secret = Deno.env.get('SYNC_SECRET');
    if (!secret || req.headers.get('x-sync-secret') !== secret) throw new HttpError(401, 'UNAUTHENTICATED');
    const verify = (await req.json().catch(() => null))?.mode === 'verify';
    const t0 = Date.now();
    const rows = await buildRows();
    const call = await openSheet();

    let check = null;
    if (verify) {
      check = await compareSheet(call, rows);
      const ok = check.diff.length === 0;
      await call(`/values/${encodeURIComponent(`${tab(CHECK_TAB)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', {
        values: [[fmtDateTime(new Date().toISOString()), String(rows.length - 1), String(check.sheetRows),
          ok ? '一致' : `有 ${check.diff.length} 張訂單不同`, check.diff.slice(0, 20).join('、'), ok ? '' : '已重新同步']],
      });
    }
    await writeSheet(call, rows);
    console.log('sync-sheet', verify ? 'verify' : 'sync', `${rows.length - 1} rows`, check ? `diff ${check.diff.length}` : '', `${Date.now() - t0}ms`);
    return reply(200, { rows: rows.length - 1, ...(check ? { sheet_rows: check.sheetRows, diff: check.diff.length } : {}) });
  } catch (e) {
    if (e instanceof HttpError) {
      console.error('sync-sheet', e.code, e.detail);
      return reply(e.status, { code: e.code, detail: e.detail });
    }
    console.error('sync-sheet unexpected error', (e as Error).message);
    return reply(500, { code: 'INTERNAL' });
  }
});
