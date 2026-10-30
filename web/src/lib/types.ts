export type Role = 'viewer' | 'staff' | 'manager' | 'admin';

export type DeviceStatus =
  | 'pending_arrival'
  | 'arrived_pending_notify'
  | 'notified_pending_pickup'
  | 'delivered'
  | 'excluded'
  | 'cancelled';

export type Me = {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  stores: { code: string; name: string }[];
};

export type Store = { code: string; name: string; is_active: boolean; receipt_prefix?: string | null };

export type Profile = {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  is_external: boolean;   // 外部帳號（個人 Google 帳號，例如工讀生）
  created_at: string;
};

export type UserStore = { user_id: string; store_code: string };

export type OrderSummary = {
  id: string;
  order_no: string;
  store_code: string;
  customer_name: string;
  customer_phone: string;
  customer_code: string | null;
  purchase_date: string;
  register_no: string;
  receipt_seq: string;
  receipt_no: string | null;
  order_note: string | null;
  version: number;
  created_by: string;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  item_count: number;
  device_total: number;
  pending_arrival: number;
  arrived_pending_notify: number;
  notified_pending_pickup: number;
  delivered: number;
  excluded: number;
  cancelled: number;
  order_status: 'in_progress' | 'completed' | 'cancelled';
};

export type BacklogRow = {
  item_id: string;
  order_id: string;
  order_no: string;
  store_code: string;
  customer_name: string;
  customer_phone: string;
  purchase_date: string;
  register_no: string;
  receipt_seq: string;
  receipt_no: string | null;
  full_product_name: string;
  model: string | null;
  barcode: string | null;
  ordered_qty: number;
  pending_arrival: number;
  arrived_pending_notify: number;
  notified_pending_pickup: number;
  delivered: number;
  excluded: number;
  item_note: string | null;
};

export type TodoRow = {
  device_id: string;
  order_id: string;
  order_item_id: string;
  unit_no: number;
  sn: string | null;
  status: DeviceStatus;
  is_labeled: boolean;
  arrived_at: string | null;
  last_notified_at: string | null;
  note: string | null;
  version: number;
  full_product_name: string;
  model: string | null;
  barcode: string | null;
  order_no: string;
  store_code: string;
  customer_name: string;
  customer_phone: string;
  purchase_date: string;
  order_created_at: string;
  item_note: string | null;
};

export type OrderItem = {
  id: string;
  order_id: string;
  line_no: number;
  product_code: string | null;
  barcode: string | null;
  full_product_name: string;
  model: string | null;
  color: string | null;
  ordered_qty: number;
  item_note: string | null;
  source: 'manual' | 'ocr';
  version: number;
  cancelled_at: string | null;
  cancellation_reason: string | null;
};

export type Device = {
  id: string;
  order_id: string;
  order_item_id: string;
  unit_no: number;
  sn: string | null;
  status: DeviceStatus;
  is_labeled: boolean;
  labeled_at: string | null;
  arrived_at: string | null;
  arrived_by: string | null;
  last_notified_at: string | null;
  delivered_at: string | null;
  delivered_by: string | null;
  exclusion_reason: string | null;
  cancellation_reason: string | null;
  delivery_note: string | null;
  delivered_staff_no: string | null;
  note: string | null;
  version: number;
};

export type Notification = {
  id: string;
  device_id: string;
  notified_at: string;
  operator_id: string;
  method: string;
  outcome: string;
  is_success: boolean;
  note: string | null;
};

export type AuditLog = {
  id: number;
  occurred_at: string;
  txn_id: number;
  store_code: string | null;
  order_id: string | null;
  order_item_id: string | null;
  device_id: string | null;
  entity_type: string;
  entity_id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  action: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_db_role: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  changed_fields: string[] | null;
  reason: string | null;
};

// 新增訂單頁的商品草稿（尚未送出，只存在瀏覽器中）
export type DraftDevice = { initial_status: 'pending_arrival' | 'excluded'; exclusion_reason: string };
export type DraftItem = {
  key: string;
  full_product_name: string;
  barcode: string;
  model: string;
  item_note: string;
  devices: DraftDevice[];
  source?: 'manual' | 'ocr';
  product_code?: string;   // 掃描到的內部代碼，不顯示
  scan_notes?: string[];   // 掃描交叉核對不符的地方，編輯儲存後清除
  scan_fixes?: string[];   // 掃描時已自動校正的地方（僅提示）
};
