-- 試算表同步防護（決策 2026-10-30）：這次要寫入的列數比試算表現有的少一半以上（或變成 0）時，
-- 不覆蓋試算表、暫停同步並通知；管理者確認資料正確後按「允許下一次同步」才恢復。
-- 正式上線前清除測試資料後也會觸發，屬正常，按允許即可。

alter table app.sheet_sync
  add column blocked_at     timestamptz,
  add column blocked_reason text,
  add column allow_shrink   boolean not null default false;

create or replace function public.get_sheet_link()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles := app.current_profile();
begin
  if v_me.user_id is null then perform app.fail('UNAUTHENTICATED'); end if;
  if v_me.role not in ('viewer', 'manager', 'admin') then perform app.fail('FORBIDDEN', 'sheet'); end if;
  return (select jsonb_build_object('url', url, 'last_synced_at', last_synced_at, 'last_rows', last_rows,
                                    'blocked_at', blocked_at, 'blocked_reason', blocked_reason, 'allow_shrink', allow_shrink)
          from app.sheet_sync where id = 1);
end $$;

-- 同步程式讀取資料時一併取得「允許大量減少」的旗標
create or replace function public.sheet_sync_data()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'allow_shrink', (select allow_shrink from app.sheet_sync where id = 1),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.purchase_date desc, o.order_no desc)
      from (select id, order_no, store_code, customer_name, customer_phone, purchase_date, register_no, receipt_seq,
                   receipt_no, order_note, order_status from public.v_order_summary) o), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at, i.item_id)
      from (select item_id, order_id, full_product_name, model, barcode, created_at from public.v_item_backlog) i), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d) order by d.unit_no, d.id)
      from (select id, order_id, order_item_id, unit_no, sn, status, is_labeled, arrived_at, last_notified_at, delivered_at, note
            from public.devices where status <> 'cancelled') d), '[]'::jsonb))
$$;

-- 同步成功：記錄時間與列數，解除暫停與允許旗標
create or replace function public.sheet_sync_done(p_rows int)
returns void language sql security definer set search_path = '' as $$
  update app.sheet_sync set last_synced_at = now(), last_rows = p_rows,
         blocked_at = null, blocked_reason = null, allow_shrink = false
  where id = 1
$$;

-- 同步被擋下：記錄原因；回傳是否為「這次才開始暫停」（只在第一次寄通知）
create function public.sheet_sync_block(p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_was timestamptz;
begin
  select blocked_at into v_was from app.sheet_sync where id = 1 for update;
  update app.sheet_sync set blocked_at = coalesce(blocked_at, now()), blocked_reason = p_reason where id = 1;
  return v_was is null;
end $$;
revoke all on function public.sheet_sync_block(text) from public, anon, authenticated;
grant execute on function public.sheet_sync_block(text) to service_role;

-- 管理者確認資料正確（例如清除測試資料後），允許下一次同步大量減少
create function public.admin_allow_sheet_shrink()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text;
begin
  v_me := app.begin_action('admin_allow_sheet_shrink', 'admin');
  select blocked_reason into v_reason from app.sheet_sync where id = 1 for update;
  update app.sheet_sync set allow_shrink = true where id = 1;
  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role, after_data)
  values ('setting', 'sheet_sync', 'UPDATE', 'admin_allow_sheet_shrink', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('blocked_reason', v_reason));
  return jsonb_build_object('allow_shrink', true);
end $$;
revoke all on function public.admin_allow_sheet_shrink() from public, anon;
grant execute on function public.admin_allow_sheet_shrink() to authenticated;
