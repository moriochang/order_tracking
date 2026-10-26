-- 列表與待辦清單也顯示商品備註（例如「AC+」），與單機備註一起提示（決策 2026-10-26）
-- create or replace view 只能在最後面加欄位

create or replace view public.v_item_backlog with (security_invoker = true) as
select
  i.id as item_id, i.order_id, o.order_no, o.store_code,
  o.customer_name, o.customer_phone, o.purchase_date, o.register_no, o.receipt_seq, o.receipt_no,
  i.full_product_name, i.model, i.barcode, i.ordered_qty,
  count(*) filter (where d.status = 'pending_arrival')::int         as pending_arrival,
  count(*) filter (where d.status = 'arrived_pending_notify')::int  as arrived_pending_notify,
  count(*) filter (where d.status = 'notified_pending_pickup')::int as notified_pending_pickup,
  count(*) filter (where d.status = 'delivered')::int               as delivered,
  count(*) filter (where d.status = 'excluded')::int                as excluded,
  o.created_at,
  i.item_note
from public.order_items i
join public.orders o on o.id = i.order_id
left join public.devices d on d.order_item_id = i.id
where i.cancelled_at is null and o.cancelled_at is null
group by i.id, o.id;

create or replace view public.v_device_todo with (security_invoker = true) as
select
  d.id as device_id, d.order_id, d.order_item_id, d.unit_no, d.sn, d.status, d.is_labeled,
  d.arrived_at, d.last_notified_at, d.note, d.version,
  i.full_product_name, i.model, i.barcode,
  o.order_no, o.store_code, o.customer_name, o.customer_phone, o.purchase_date, o.created_at as order_created_at,
  i.item_note
from public.devices d
join public.order_items i on i.id = d.order_item_id
join public.orders o on o.id = d.order_id
where d.status in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup')
  and o.cancelled_at is null and i.cancelled_at is null;
