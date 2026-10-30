import type { DeviceStatus, Role } from './types';
import { ApiError } from './api';

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  pending_arrival: '待到貨',
  arrived_pending_notify: '已到貨',
  notified_pending_pickup: '已通知',
  delivered: '已取貨',
  excluded: '已取走／不追蹤',
  cancelled: '已取消',
};

export const METHOD_LABEL: Record<string, string> = {
  phone: '電話', sms: '簡訊', messaging_app: '通訊軟體', in_person: '顧客到店', other: '其他',
};
export const OUTCOME_LABEL: Record<string, string> = {
  contacted: '已聯絡', message_sent: '訊息已送出', no_answer: '無人接聽', not_reached: '未聯絡成功',
};

export const ORDER_STATUS_LABEL = { in_progress: '進行中', completed: '已完成', cancelled: '已取消' } as const;

export const ROLE_LABEL: Record<Role, string> = { viewer: '門市檢視', staff: '門市同仁', manager: '門市主管', admin: '總部管理者' };
// 門市檢視只能看與匯出，不能做任何修改（資料庫也會拒絕）
export const canEdit = (role: Role) => role !== 'viewer';
export const canExport = (role: Role) => role !== 'staff';
// 外部帳號（個人 Google 帳號）可選的角色
export const EXTERNAL_ROLES: Role[] = ['viewer', 'staff'];

export const ACTION_LABEL: Record<string, string> = {
  create_order: '建立訂單',
  update_order_info: '修改訂單資料',
  add_order_item: '新增商品',
  update_order_item: '修改商品',
  change_item_quantity: '修改數量',
  cancel_device: '取消單機',
  cancel_order_item: '取消商品',
  cancel_order: '取消訂單',
  register_arrival: '登記到貨',
  record_notification: '通知顧客',
  set_labeled: '已貼',
  complete_delivery: '完成取貨',
  correct_sn: '更正 SN',
  correct_device_status: '更正狀態',
  admin_upsert_store: '門市設定',
  admin_create_user: '建立帳號',
  admin_update_user: '修改帳號',
  bootstrap_admin: '建立第一位管理者',
  system_migration: '系統調整',
  admin_import_catalog: '匯入產品資料',
  admin_set_sheet_link: '設定試算表網址',
  admin_allow_sheet_shrink: '允許試算表同步（資料大量減少）',
  update_device_note: '單機備註',
  export_orders: '匯出訂單',
  reset_test_data: '清除測試資料',
  direct_db_change: '⚠ 未經系統流程的資料庫修改',
};

export const FIELD_LABEL: Record<string, string> = {
  sheet_url: '試算表網址',
  customer_name: '顧客姓名',
  customer_phone: '電話',
  customer_code: '顧客編號',
  purchase_date: '結帳日期',
  register_no: '收銀機號',
  receipt_seq: '序號',
  receipt_no: '預結號碼',
  order_note: '訂單備註',
  duplicate_ack_reason: '重複單據確認原因',
  full_product_name: '商品名稱',
  product_code: '料號',
  barcode: '國際條碼',
  model: '型號',
  color: '顏色／規格',
  ordered_qty: '數量',
  item_note: '商品備註',
  note: '單機備註',
  delivery_note: '取貨備註',
  sn: 'SN',
  status: '狀態',
  is_labeled: '已貼',
  arrived_at: '到貨時間',
  delivered_at: '取貨時間',
  last_notified_at: '最近通知',
  exclusion_reason: '排除原因',
  cancelled_at: '取消時間',
  cancellation_reason: '取消原因',
  display_name: '姓名',
  role: '角色',
  is_active: '啟用',
  name: '名稱',
};

// 時間軸篩選分類
export const AUDIT_FILTERS: { key: string; label: string; actions: string[] }[] = [
  { key: 'all', label: '全部異動', actions: [] },
  { key: 'order', label: '訂單資料', actions: ['create_order', 'update_order_info'] },
  { key: 'item', label: '商品／SN', actions: ['add_order_item', 'update_order_item', 'change_item_quantity', 'correct_sn', 'update_device_note'] },
  { key: 'arrival', label: '到貨', actions: ['register_arrival'] },
  { key: 'notify', label: '通知', actions: ['record_notification'] },
  { key: 'label', label: '已貼', actions: ['set_labeled'] },
  { key: 'deliver', label: '取貨', actions: ['complete_delivery'] },
  { key: 'cancel', label: '取消／更正', actions: ['cancel_device', 'cancel_order_item', 'cancel_order', 'correct_device_status', 'direct_db_change'] },
];

const ERROR_MESSAGE: Record<string, string> = {
  UNAUTHENTICATED: '登入已失效或帳號未開通，請重新登入。',
  FORBIDDEN: '你沒有執行這項操作的權限。',
  NOT_FOUND: '找不到資料，或你沒有查看權限。',
  STATE_CHANGED: '資料已被其他人更新，請重新載入後再操作。',
  VALIDATION: '資料格式不正確，請檢查必填欄位與格式。',
  REASON_REQUIRED: '請填寫原因。',
  ITEMS_REQUIRED: '請至少加入一項商品。',
  ITEM_NAME_REQUIRED: '請填寫完整商品名稱。',
  INVALID_QTY: '數量必須是 1–999 的整數。',
  ILLEGAL_INITIAL_STATUS: '建立時只能選擇「待到貨」或「已取走／不追蹤」。',
  ILLEGAL_TRANSITION: '這台機器目前的狀態不允許這項操作。',
  DUPLICATE_RECEIPT: '此門市已有相同預結號碼的訂單，不能重複建立。',
  POSSIBLE_DUPLICATE: '疑似重複單據，請確認後填寫原因。',
  DUPLICATE_SUBMIT: '此訂單已送出過，請勿重複送出。',
  SN_DUPLICATE: '此 SN 已登記在其他機器上，請查核。',
  ORDER_CANCELLED: '此訂單已取消，不能再修改。',
  ITEM_CANCELLED: '此商品已取消，不能再修改。',
  HAS_DELIVERED_DEVICES: '已有機器完成取貨，不能整筆取消；請逐台取消未取貨的機器。',
  DEVICE_NOT_CANCELLABLE: '這台機器目前的狀態不能取消。',
  DEVICE_NOT_CANCELLABLE_FOR_QTY: '減少數量時只能取消「待到貨」或「已取走」的機器；其他機器請使用單機取消。',
  CANCEL_COUNT_MISMATCH: '請勾選與減少數量相同台數的機器。',
  NO_CHANGE: '數量沒有變更。',
  QTY_MISMATCH: '數量與單機數不一致，操作已取消。',
  STORE_INACTIVE: '此門市已停用。',
  EMAIL_EXISTS: '此 Email 已有帳號。',
  AUTH_ACCOUNT_EXISTS: '此登入帳號已開通。',
  CANNOT_MODIFY_SELF: '不能變更自己的角色或停用自己。',
  DOMAIN_NOT_ALLOWED: '只能開通公司網域的 Email。',
  PURCHASE_DATE_LOCKED: '結帳日期固定為建單當天，不能修改。',
  EXTERNAL_ROLE_NOT_ALLOWED: '外部帳號（個人 Google 帳號）只能設為門市同仁或門市檢視。',
  INVALID_BARCODE: '國際條碼格式或檢查碼不正確，請核對條碼數字。',
  SERVER_NOT_CONFIGURED: '伺服器尚未設定 Firebase 服務帳戶，請聯絡系統管理者。',
  OCR_PROVIDER_ERROR: '辨識服務暫時無法使用，請稍後再試，或改用手動輸入。',
  OCR_TIMEOUT: '辨識逾時，請重新拍照或改用手動輸入。',
  IMAGE_UNSUPPORTED: '這個瀏覽器無法讀取這張照片（例如 HEIC 格式）。請用 iPhone 直接拍照，或先轉成 JPG 再上傳。',
  IMAGE_TOO_LARGE: '照片太大，請重新拍照。',
  DUPLICATE: '資料重複，例如預結號碼開頭已被其他門市使用。',
  SN_REQUIRED: '請輸入 SN。',
  LABEL_NOT_ALLOWED: '只有已到貨、尚未取貨的機器可以標記已貼。',
  ADD_ITEM_NOT_ALLOWED: '訂單建立後不能再新增商品或增加數量，請另開新訂單。',
  NETWORK: '網路或伺服器錯誤，操作可能未完成，請重新載入確認。',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return ERROR_MESSAGE[e.code] ?? `操作失敗（${e.code}）`;
  }
  if (e instanceof TypeError) return ERROR_MESSAGE.NETWORK;
  return `操作失敗：${(e as Error)?.message ?? e}`;
}
