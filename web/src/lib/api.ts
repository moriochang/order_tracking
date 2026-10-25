// 資料存取：讀取走資料表／view（受 RLS 限制），寫入只能呼叫 RPC。
import { supabase } from './clients';
import type { OcrWord } from './ocrLayout';
import type { CatalogEntry } from './catalogMatch';
import type { AuditLog, Device, Me, Notification, OrderItem, OrderSummary, Profile, Store, UserStore } from './types';

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

export async function searchOrders(opts: { q?: string; storeCode?: string; limit?: number }) {
  let query = supabase.from('v_order_summary').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 50);
  if (opts.storeCode) query = query.eq('store_code', opts.storeCode);
  const q = (opts.q ?? '').replace(/[,()*%\\]/g, ' ').trim();
  if (q) {
    const digits = q.replace(/[\s-]/g, '');
    const parts = [`order_no.ilike.*${q}*`, `customer_name.ilike.*${q}*`, `receipt_no.ilike.*${q}*`];
    if (/^\+?[0-9#]+$/.test(digits)) parts.push(`customer_phone.ilike.*${digits}*`);
    query = query.or(parts.join(','));
  }
  return unwrap(await query) as OrderSummary[];
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
