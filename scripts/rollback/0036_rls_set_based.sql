-- 還原 0036：讀取權限回到逐筆判斷（權限範圍相同，只是較慢）。只有在 0036 造成問題時才在 SQL Editor 執行。
alter policy read_store on public.orders using (app.can_access_store(store_code));
alter policy read_store on public.order_items using (app.can_access_order(order_id));
alter policy read_store on public.devices using (app.can_access_order(order_id));
alter policy read_store on public.notifications using (app.can_access_order(order_id));
drop function app.visible_store_codes();
