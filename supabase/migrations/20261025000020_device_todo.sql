-- 待辦清單：每台尚未完成的單機一列，附商品與訂單資料（決策 2026-10-26）
-- 只含未取消訂單中「待到貨、已到貨待通知、已通知待取貨」的機器；security_invoker 讓 RLS 依門市權限過濾。

create view public.v_device_todo with (security_invoker = true) as
select
  d.id as device_id, d.order_id, d.order_item_id, d.unit_no, d.sn, d.status, d.is_labeled,
  d.arrived_at, d.last_notified_at, d.note, d.version,
  i.full_product_name, i.model, i.barcode,
  o.order_no, o.store_code, o.customer_name, o.customer_phone, o.purchase_date, o.created_at as order_created_at
from public.devices d
join public.order_items i on i.id = d.order_item_id
join public.orders o on o.id = d.order_id
where d.status in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup')
  and o.cancelled_at is null and i.cancelled_at is null;

grant select on public.v_device_todo to authenticated;
