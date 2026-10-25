-- 預購商品追蹤系統：資料表結構
-- 設計依據 docs/design-phase1.md §3

create schema if not exists app;

-- ── 列舉 ───────────────────────────────────────────────
create type public.app_role as enum ('staff', 'manager', 'admin');  -- 順序代表權限高低

create type public.device_status as enum (
  'pending_arrival',          -- 待到貨
  'arrived_pending_notify',   -- 已到貨待通知
  'notified_pending_pickup',  -- 已通知待取貨
  'delivered',                -- 已交付
  'excluded',                 -- 已取走／不追蹤（只允許建立時設定）
  'cancelled'                 -- 已取消
);

create type public.item_source as enum ('manual', 'ocr');

-- ── 門市與使用者 ─────────────────────────────────────────
create table public.stores (
  code        text primary key check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name        text not null check (btrim(name) <> ''),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 內部使用者。登入身分來自 Firebase，以 (auth_iss, auth_uid) 對應；
-- 所有 *_by 欄位都指向 user_id，因此日後更換登入供應商不影響歷史紀錄。
create table public.profiles (
  user_id       uuid primary key default gen_random_uuid(),
  auth_iss      text not null,
  auth_uid      text not null,
  email         text not null check (email = lower(btrim(email)) and email like '%@%'),
  display_name  text not null check (btrim(display_name) <> ''),
  role          public.app_role not null default 'staff',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (auth_iss, auth_uid),
  unique (email)
);

create table public.user_stores (
  user_id     uuid not null references public.profiles(user_id),
  store_code  text not null references public.stores(code),
  created_at  timestamptz not null default now(),
  primary key (user_id, store_code)
);

-- ── 訂單 ─────────────────────────────────────────────
create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_no             text not null unique,
  store_code           text not null references public.stores(code),
  customer_name        text not null check (btrim(customer_name) <> ''),
  customer_phone       text not null check (customer_phone ~ '^\+?[0-9#]{6,20}$'),
  customer_code        text,
  purchase_date        date not null,
  register_no          text not null check (register_no ~ '^[0-9A-Za-z]{1,10}$'),
  receipt_seq          text not null check (receipt_seq ~ '^[0-9A-Za-z]{1,20}$'),
  receipt_no           text check (receipt_no is null or (receipt_no = upper(btrim(receipt_no)) and receipt_no <> '')),
  order_note           text,
  duplicate_ack_reason text,
  client_request_id    uuid not null unique,
  version              int  not null default 1,
  created_by           uuid not null references public.profiles(user_id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(user_id),
  cancellation_reason  text,
  constraint orders_cancel_fields check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null and btrim(coalesce(cancellation_reason, '')) <> '')
  )
);
-- 同門市同一完整單據號碼視為硬性重複（已取消的訂單除外）
create unique index orders_receipt_no_uniq on public.orders (store_code, receipt_no)
  where receipt_no is not null and cancelled_at is null;
create index orders_receipt_lookup on public.orders (store_code, register_no, receipt_seq, purchase_date);
create index orders_phone on public.orders (customer_phone);
create index orders_store_created on public.orders (store_code, created_at desc);

-- ── 商品明細 ───────────────────────────────────────────
create table public.order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id),
  line_no              int  not null check (line_no > 0),
  product_code         text,
  full_product_name    text not null check (btrim(full_product_name) <> ''),
  model                text,
  color                text,
  ordered_qty          int  not null check (ordered_qty > 0),  -- 等於未取消的單機數（見 app.check_item_qty）
  item_note            text,
  source               public.item_source not null default 'manual',
  import_draft_id      uuid,
  client_request_id    uuid unique,
  version              int  not null default 1,
  created_by           uuid not null references public.profiles(user_id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(user_id),
  cancellation_reason  text,
  unique (order_id, line_no),
  constraint order_items_cancel_fields check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null and btrim(coalesce(cancellation_reason, '')) <> '')
  )
);
create index order_items_order on public.order_items (order_id);

-- ── 單機：每台實體機器一筆 ─────────────────────────────────
create table public.devices (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id),
  order_item_id        uuid not null references public.order_items(id),
  unit_no              int  not null check (unit_no > 0),
  sn                   text check (sn is null or (sn = upper(btrim(sn)) and sn <> '')),
  status               public.device_status not null,
  is_labeled           boolean not null default false,
  labeled_at           timestamptz,
  labeled_by           uuid references public.profiles(user_id),
  arrived_at           timestamptz,
  arrived_by           uuid references public.profiles(user_id),
  last_notified_at     timestamptz,
  delivered_at         timestamptz,
  delivered_by         uuid references public.profiles(user_id),
  delivery_note        text,
  excluded_at          timestamptz,
  excluded_by          uuid references public.profiles(user_id),
  exclusion_reason     text,
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(user_id),
  cancellation_reason  text,
  status_before_cancel public.device_status,
  version              int  not null default 1,
  created_by           uuid not null references public.profiles(user_id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (order_item_id, unit_no),

  -- 各狀態必須具備的欄位；到貨後 SN 必填（決策 S4）
  constraint devices_arrived_fields check (
    status not in ('arrived_pending_notify', 'notified_pending_pickup', 'delivered')
    or (arrived_at is not null and arrived_by is not null and sn is not null)
  ),
  constraint devices_notified_fields check (
    status not in ('notified_pending_pickup', 'delivered') or last_notified_at is not null
  ),
  constraint devices_delivered_fields check (
    (status = 'delivered') = (delivered_at is not null and delivered_by is not null)
    or status = 'cancelled'
  ),
  constraint devices_pending_fields check (
    status <> 'pending_arrival' or (arrived_at is null and sn is null)
  ),
  constraint devices_excluded_fields check (
    status <> 'excluded'
    or (excluded_at is not null and excluded_by is not null and btrim(coalesce(exclusion_reason, '')) <> '')
  ),
  constraint devices_cancelled_fields check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (status <> 'cancelled'
         or (cancelled_by is not null and status_before_cancel is not null
             and btrim(coalesce(cancellation_reason, '')) <> ''))
  ),
  constraint devices_labeled_fields check (
    not is_labeled or (labeled_at is not null and labeled_by is not null)
  )
);
-- SN 唯一（忽略空值與已取消的機器）
create unique index devices_sn_uniq on public.devices (sn)
  where sn is not null and status <> 'cancelled';
create index devices_order on public.devices (order_id);
create index devices_item on public.devices (order_item_id);
create index devices_open_status on public.devices (status)
  where status in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup');

-- ── 通知 ─────────────────────────────────────────────
create table public.notification_methods (
  code       text primary key,
  label      text not null,
  sort       int  not null default 0,
  is_active  boolean not null default true
);

create table public.notification_outcomes (
  code        text primary key,
  label       text not null,
  is_success  boolean not null,   -- true 才會把單機轉為已通知待取貨（決策 S3：預設全部為 true）
  sort        int  not null default 0,
  is_active   boolean not null default true
);

insert into public.notification_methods (code, label, sort) values
  ('phone', '電話', 1), ('sms', '簡訊', 2), ('messaging_app', '通訊軟體', 3), ('other', '其他', 9);

insert into public.notification_outcomes (code, label, is_success, sort) values
  ('contacted', '已聯絡', true, 1),
  ('message_sent', '訊息已送出', true, 2),
  ('no_answer', '無人接聽', true, 3),
  ('not_reached', '未聯絡成功', true, 4);

-- 每次通知一筆，只能新增
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null,
  device_id    uuid not null references public.devices(id),
  order_id     uuid not null references public.orders(id),
  notified_at  timestamptz not null default now(),
  operator_id  uuid not null references public.profiles(user_id),
  method       text not null references public.notification_methods(code),
  outcome      text not null references public.notification_outcomes(code),
  is_success   boolean not null,
  note         text,
  created_at   timestamptz not null default now()
);
create index notifications_device on public.notifications (device_id, notified_at desc);
create index notifications_order on public.notifications (order_id);

-- ── 稽核：只能新增，由觸發器寫入 ──────────────────────────────
create table public.audit_logs (
  id                  bigint generated always as identity primary key,
  occurred_at         timestamptz not null default now(),
  txn_id              bigint not null default txid_current(),
  store_code          text,
  order_id            uuid,
  order_item_id       uuid,
  device_id           uuid,
  entity_type         text not null,
  entity_id           text not null,
  operation           text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  action              text not null,
  actor_user_id       uuid,
  actor_display_name  text,
  actor_db_role       text not null,
  before_data         jsonb,
  after_data          jsonb,
  changed_fields      text[],
  reason              text,
  metadata            jsonb
);
create index audit_logs_order on public.audit_logs (order_id, occurred_at desc);
create index audit_logs_device on public.audit_logs (device_id, occurred_at desc);
create index audit_logs_actor on public.audit_logs (actor_user_id, occurred_at desc);

-- ── OCR 草稿（第四階段啟用） ─────────────────────────────────
create table public.import_drafts (
  id                  uuid primary key default gen_random_uuid(),
  store_code          text not null references public.stores(code),
  image_storage_path  text not null,
  ocr_raw_result      jsonb,
  parsed_fields       jsonb,
  status              text not null default 'pending'
                      check (status in ('pending', 'confirmed', 'discarded', 'failed')),
  order_id            uuid references public.orders(id),
  created_by          uuid not null references public.profiles(user_id),
  created_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  confirmed_by        uuid references public.profiles(user_id)
);
alter table public.order_items
  add constraint order_items_import_draft_fk foreign key (import_draft_id) references public.import_drafts(id);

-- ── 訂單編號流水號 ─────────────────────────────────────
create table app.order_no_counters (
  store_code  text not null,
  day         date not null,
  last_seq    int  not null,
  primary key (store_code, day)
);
