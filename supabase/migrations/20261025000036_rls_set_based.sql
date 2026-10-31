-- 讀取權限改為「每次查詢只算一次」（決策 2026-10-31）：權限範圍不變，只改判斷方式。
-- 原本訂單、明細、單機、通知逐筆呼叫 can_access_store / can_access_order，每一筆都重新查一次登入者與門市，
-- 3 萬張訂單時首頁與訂單列表要好幾秒。改成先算出「我能看的門市」一次，再一次篩選；
-- 明細、單機、通知跟著訂單的權限走（看得到訂單就看得到底下的資料）。
-- 寫入用的 RPC 自己檢查權限，不受影響。還原方式見 scripts/rollback/0036_rls_set_based.sql。

-- 管理者：全部門市；其他有效帳號：自己被指派的門市；停用或未登入：空
create function app.visible_store_codes()
returns text[] language sql stable security definer set search_path = '' as $$
  select case
    when app.current_role() is null then '{}'::text[]
    when app.current_role() = 'admin' then coalesce((select array_agg(s.code) from public.stores s), '{}')
    else coalesce((select array_agg(us.store_code) from public.user_stores us where us.user_id = app.current_user_id()), '{}')
  end
$$;
revoke all on function app.visible_store_codes() from public, anon;
grant execute on function app.visible_store_codes() to authenticated;

alter policy read_store on public.orders
  using (store_code in (select unnest(app.visible_store_codes())));
alter policy read_store on public.order_items
  using (order_id in (select o.id from public.orders o));
alter policy read_store on public.devices
  using (order_id in (select o.id from public.orders o));
alter policy read_store on public.notifications
  using (order_id in (select o.id from public.orders o));
