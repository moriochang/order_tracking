-- 依型號查欠貨：每個商品明細一列，附訂單資料與各狀態台數（決策 2026-10-25）
-- 欠貨 = 待到貨台數。只含未取消的訂單與商品；security_invoker 讓 RLS 依查詢者門市權限過濾。

create view public.v_item_backlog with (security_invoker = true) as
select
  i.id as item_id, i.order_id, o.order_no, o.store_code,
  o.customer_name, o.customer_phone, o.purchase_date, o.register_no, o.receipt_seq, o.receipt_no,
  i.full_product_name, i.model, i.barcode, i.ordered_qty,
  count(*) filter (where d.status = 'pending_arrival')::int         as pending_arrival,
  count(*) filter (where d.status = 'arrived_pending_notify')::int  as arrived_pending_notify,
  count(*) filter (where d.status = 'notified_pending_pickup')::int as notified_pending_pickup,
  count(*) filter (where d.status = 'delivered')::int               as delivered,
  count(*) filter (where d.status = 'excluded')::int                as excluded,
  o.created_at
from public.order_items i
join public.orders o on o.id = i.order_id
left join public.devices d on d.order_item_id = i.id
where i.cancelled_at is null and o.cancelled_at is null
group by i.id, o.id;

grant select on public.v_item_backlog to authenticated;
create index if not exists order_items_model on public.order_items (model);
