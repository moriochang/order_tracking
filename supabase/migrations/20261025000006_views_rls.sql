-- 統計 view、權限與 RLS
-- 設計依據 docs/design-phase1.md §3.1、§3.2

-- ── 統計 view（security_invoker：套用查詢者的 RLS） ───────────────
create view public.v_order_summary with (security_invoker = on) as
select
  o.id, o.order_no, o.store_code, o.customer_name, o.customer_phone, o.customer_code,
  o.purchase_date, o.register_no, o.receipt_seq, o.receipt_no, o.order_note,
  o.version, o.created_by, o.created_at, o.cancelled_at, o.cancellation_reason,
  coalesce(i.item_count, 0) as item_count,
  coalesce(d.device_total, 0) as device_total,
  coalesce(d.pending_arrival, 0) as pending_arrival,
  coalesce(d.arrived_pending_notify, 0) as arrived_pending_notify,
  coalesce(d.notified_pending_pickup, 0) as notified_pending_pickup,
  coalesce(d.delivered, 0) as delivered,
  coalesce(d.excluded, 0) as excluded,
  coalesce(d.cancelled, 0) as cancelled,
  case
    when o.cancelled_at is not null then 'cancelled'
    when coalesce(d.open_count, 0) = 0 then 'completed'
    else 'in_progress'
  end as order_status
from public.orders o
left join lateral (
  select count(*) filter (where it.cancelled_at is null) as item_count
  from public.order_items it where it.order_id = o.id
) i on true
left join lateral (
  select
    count(*) filter (where dv.status <> 'cancelled') as device_total,
    count(*) filter (where dv.status = 'pending_arrival') as pending_arrival,
    count(*) filter (where dv.status = 'arrived_pending_notify') as arrived_pending_notify,
    count(*) filter (where dv.status = 'notified_pending_pickup') as notified_pending_pickup,
    count(*) filter (where dv.status = 'delivered') as delivered,
    count(*) filter (where dv.status = 'excluded') as excluded,
    count(*) filter (where dv.status = 'cancelled') as cancelled,
    count(*) filter (where dv.status in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup')) as open_count
  from public.devices dv where dv.order_id = o.id
) d on true;

-- 首頁待辦數。待貼標：未貼且已到貨尚未交付（決策 S1）。已取消、已取走不計入。
create view public.v_todo_counts with (security_invoker = on) as
select
  o.store_code,
  count(*) filter (where d.status = 'pending_arrival') as pending_arrival,
  count(*) filter (where d.status = 'arrived_pending_notify') as arrived_pending_notify,
  count(*) filter (where not d.is_labeled
                     and d.status in ('arrived_pending_notify', 'notified_pending_pickup')) as pending_label,
  count(*) filter (where d.status = 'notified_pending_pickup') as notified_pending_pickup,
  count(*) filter (where d.status = 'delivered') as delivered
from public.devices d
join public.orders o on o.id = d.order_id
group by o.store_code;

-- ── 權限：前端只能讀，寫入只能透過 RPC ───────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke insert, update, delete, truncate on all tables in schema public from service_role;
revoke all on all tables in schema app from public, anon, authenticated, service_role;

grant select on
  public.stores, public.profiles, public.user_stores,
  public.orders, public.order_items, public.devices, public.notifications,
  public.notification_methods, public.notification_outcomes,
  public.audit_logs, public.import_drafts,
  public.v_order_summary, public.v_todo_counts
to authenticated;

-- 函式：預設全部撤銷，只開放公開 RPC 與 RLS 需要的輔助函式
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema app from public, anon, authenticated;
grant usage on schema app to authenticated;
grant execute on function
  app.current_profile(), app.current_user_id(), app.current_role(),
  app.can_access_store(text), app.can_access_order(uuid)
to authenticated;
grant execute on function
  public.get_me(),
  public.check_duplicate_order(text, text, text, text, date, uuid),
  public.create_order(jsonb),
  public.update_order_info(uuid, int, jsonb, text),
  public.add_order_item(uuid, jsonb),
  public.update_order_item(uuid, int, jsonb, text),
  public.change_item_quantity(uuid, int, int, uuid[], text),
  public.cancel_device(uuid, int, text),
  public.cancel_order_item(uuid, int, text),
  public.cancel_order(uuid, int, text),
  public.admin_upsert_store(text, text, boolean),
  public.admin_create_user(text, text, text, public.app_role, text[]),
  public.admin_update_user(uuid, jsonb, text)
to authenticated;

-- 之後新增的資料表與函式也不自動開放
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ── RLS ─────────────────────────────────────────────
alter table public.stores enable row level security;
alter table public.profiles enable row level security;
alter table public.user_stores enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.devices enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_methods enable row level security;
alter table public.notification_outcomes enable row level security;
alter table public.audit_logs enable row level security;
alter table public.import_drafts enable row level security;

create policy read_active_users on public.stores for select to authenticated
  using (app.current_role() is not null);
create policy read_active_users on public.notification_methods for select to authenticated
  using (app.current_role() is not null);
create policy read_active_users on public.notification_outcomes for select to authenticated
  using (app.current_role() is not null);

-- 自己、admin，或與自己有共同門市的同仁（用來顯示操作者姓名）
create policy read_colleagues on public.profiles for select to authenticated
  using (
    user_id = app.current_user_id()
    or app.current_role() = 'admin'
    or exists (select 1 from public.user_stores theirs
               where theirs.user_id = profiles.user_id and app.can_access_store(theirs.store_code))
  );

create policy read_own_or_store on public.user_stores for select to authenticated
  using (user_id = app.current_user_id() or app.can_access_store(store_code));

create policy read_store on public.orders for select to authenticated
  using (app.can_access_store(store_code));
create policy read_store on public.order_items for select to authenticated
  using (app.can_access_order(order_id));
create policy read_store on public.devices for select to authenticated
  using (app.can_access_order(order_id));
create policy read_store on public.notifications for select to authenticated
  using (app.can_access_order(order_id));

-- 門市相關事件依門市權限；帳號、門市設定等非門市事件只有 admin 可看
create policy read_store on public.audit_logs for select to authenticated
  using (
    case when store_code is null then app.current_role() = 'admin'
         else app.can_access_store(store_code) end
  );

create policy read_own_or_manager on public.import_drafts for select to authenticated
  using (
    created_by = app.current_user_id()
    or (app.current_role() >= 'manager' and app.can_access_store(store_code))
  );
