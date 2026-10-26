// 資料存取：讀取走資料表／view（受 RLS 限制），寫入只能呼叫 RPC。
import { supabase } from './clients';
import type { OcrWord } from './ocrLayout';
import type { CatalogEntry } from './catalogMatch';
import type { AuditLog, BacklogRow, Device, Me, Notification, OrderItem, OrderSummary, Profile, Store, UserStore } from './types';

export class ApiError extends Error {
  constructor(public code: string, public detail = '') {
    super(code);
  }
}

type PgResult<T> = { data: T | null; error: { message: string; details?: string | null; code?: string } | null };

function unwrap<T>({ data, error }: PgResult<T>): T {
  if (error) throw new ApiError(error.message || 'UNKNOWN', error.details ?? '');
  return data as T;
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return unwrap(await supabase.rpc(fn, args)) as T;
}

export const getMe = () => rpc<Me | null>('get_me');

export async function todoCounts(storeCode?: string) {
  let q = supabase.from('v_todo_counts').select('*');
  if (storeCode) q = q.eq('store_code', storeCode);
  const rows = unwrap(await q) as Record<string, number | string>[];
  const keys = ['pending_arrival', 'arrived_pending_notify', 'pending_label', 'notified_pending_pickup', 'delivered'];
  return Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)])) as Record<string, number>;
}

export type OrderSearch = {
  q?: string;
  field?: SearchField;
  storeCode?: string;
  status?: string;     // in_progress / completed / cancelled，或 pending_arrival 等「有…的機器」
  since?: string;      // 結帳日期起（YYYY-MM-DD）
  limit?: number;
};
export type SearchField = 'all' | 'order_no' | 'customer_name' | 'customer_phone' | 'receipt_no' | 'receipt_seq' | 'model' | 'sn';

// 型號／品名、SN 在商品與單機資料表，先找出符合的訂單 id
async function orderIdsBy(field: 'model' | 'sn', q: string): Promise<string[]> {
  const res = field === 'model'
    ? await supabase.from('order_items').select('order_id').or(`model.ilike.*${q}*,full_product_name.ilike.*${q}*`).limit(300)
    : await supabase.from('devices').select('order_id').ilike('sn', `*${q}*`).limit(300);
  return [...new Set((unwrap(res) as { order_id: string }[]).map((r) => r.order_id))];
}

export async function searchOrders(opts: OrderSearch) {
  let query = supabase.from('v_order_summary').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 100);
  if (opts.storeCode) query = query.eq('store_code', opts.storeCode);
  if (opts.since) query = query.gte('purchase_date', opts.since);
  if (opts.status === 'in_progress' || opts.status === 'completed' || opts.status === 'cancelled') {
    query = query.eq('order_status', opts.status);
  } else if (opts.status) {
    query = query.gt(opts.status, 0);
  }

  const q = (opts.q ?? '').replace(/[,()*%\\]/g, ' ').trim();
  const field = opts.field ?? 'all';
  if (q) {
    const digits = q.replace(/[\s-]/g, '');
    const parts: string[] = [];
    if (field === 'all' || field === 'order_no') parts.push(`order_no.ilike.*${q}*`);
    if (field === 'all' || field === 'customer_name') parts.push(`customer_name.ilike.*${q}*`);
    if ((field === 'all' || field === 'customer_phone') && /^\+?[0-9#]+$/.test(digits)) parts.push(`customer_phone.ilike.*${digits}*`);
    if (field === 'all' || field === 'receipt_no') parts.push(`receipt_no.ilike.*${q}*`);
    if (field === 'all' || field === 'receipt_seq') parts.push(`receipt_seq.ilike.*${q}*`);
    for (const f of ['model', 'sn'] as const) {
      if (field === 'all' || field === f) {
        const ids = await orderIdsBy(f, q);
        if (ids.length) parts.push(`id.in.(${ids.join(',')})`);
      }
    }
    if (!parts.length) return [] as OrderSummary[];
    query = query.or(parts.join(','));
  }
  return unwrap(await query) as OrderSummary[];
}

// 依型號（或品名）查商品明細與欠貨台數，依結帳日期由舊到新（先訂先到）
export async function searchBacklog(opts: { q: string; storeCode?: string; onlyBacklog: boolean }) {
  const q = opts.q.replace(/[,()*%\\]/g, ' ').trim();
  if (!q) return [] as BacklogRow[];
  let query = supabase.from('v_item_backlog').select('*')
    .or(`model.ilike.*${q}*,full_product_name.ilike.*${q}*`)
    .order('purchase_date').order('created_at').limit(500);
  if (opts.storeCode) query = query.eq('store_code', opts.storeCode);
  if (opts.onlyBacklog) query = query.gt('pending_arrival', 0);
  return unwrap(await query) as BacklogRow[];
}

// 訂單列表用：各訂單未取消商品的明細與狀態台數
export async function itemsForOrders(orderIds: string[]) {
  if (!orderIds.length) return [] as BacklogRow[];
  return unwrap(await supabase.from('v_item_backlog').select('*').in('order_id', orderIds)
    .order('created_at')) as BacklogRow[];
}

export async function devicesForOrders(orderIds: string[]) {
  if (!orderIds.length) return [] as Device[];
  return unwrap(await supabase.from('devices').select('*').in('order_id', orderIds).neq('status', 'cancelled')
    .order('unit_no')) as Device[];
}

export async function loadOrder(orderId: string) {
  const [summary, items, devices, notifications, audit, scans] = await Promise.all([
    supabase.from('v_order_summary').select('*').eq('id', orderId).maybeSingle(),
    supabase.from('order_items').select('*').eq('order_id', orderId).order('line_no'),
    supabase.from('devices').select('*').eq('order_id', orderId).order('unit_no'),
    supabase.from('notifications').select('*').eq('order_id', orderId).order('notified_at', { ascending: false }),
    supabase.from('audit_logs').select('*').eq('order_id', orderId).order('id', { ascending: false }),
    supabase.from('import_drafts').select('id, raw_text, created_at').eq('order_id', orderId).order('created_at'),
  ]);
  return {
    summary: unwrap(summary) as OrderSummary | null,
    items: unwrap(items) as OrderItem[],
    devices: unwrap(devices) as Device[],
    notifications: unwrap(notifications) as Notification[],
    audit: unwrap(audit) as AuditLog[],
    scans: unwrap(scans) as { id: string; raw_text: string | null; created_at: string }[],
  };
}

export async function listProfiles() {
  return unwrap(await supabase.from('profiles').select('*').order('display_name')) as Profile[];
}

export async function listUserStores() {
  return unwrap(await supabase.from('user_stores').select('*')) as UserStore[];
}

export async function listStores() {
  return unwrap(await supabase.from('stores').select('*').order('code')) as Store[];
}

export async function listAdminAudit(limit = 100) {
  return unwrap(await supabase.from('audit_logs').select('*').is('order_id', null)
    .order('id', { ascending: false }).limit(limit)) as AuditLog[];
}

// Edge Function：建立 Firebase 帳號並開通（admin 專用）
export async function adminCreateUser(input: { email: string; display_name: string; role: string; store_codes: string[] }) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: { action: 'create', ...input } });
  if (error) {
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError(body?.code ?? 'NETWORK', body?.detail ?? '');
  }
  return data as { user_id: string; email: string };
}

// 產品資料：依型號查建檔品名（校正辨識結果用）
export async function catalogByModels(models: string[]) {
  if (!models.length) return [] as CatalogEntry[];
  return unwrap(await supabase.from('product_catalog').select('product_name, model').in('model', models)) as CatalogEntry[];
}

export async function catalogCount() {
  const { count, error } = await supabase.from('product_catalog').select('code', { count: 'exact', head: true });
  if (error) throw new ApiError(error.message);
  return count ?? 0;
}

// Edge Function：拍照辨識（Google Cloud Vision），回傳字詞與位置；圖片不儲存
export async function ocrReceipt(imageBase64: string) {
  const { data, error } = await supabase.functions.invoke('ocr-receipt', { body: { image: imageBase64 } });
  if (error) {
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError(body?.code ?? 'NETWORK', body?.detail ?? '');
  }
  return data as { provider: string; text: string; words: OcrWord[] };
}
