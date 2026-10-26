-- 合併相同商品：同一張訂單裡品名、型號、國際條碼、商品備註都相同的兩項，合併成一項（決策 2026-10-26）
-- 只有來源項目的機器都還是「待到貨」時才能合併：在目標項目新增同數量的待到貨機器，來源項目整項取消。
-- 不搬移既有單機（單機所屬商品不可變更），所有異動都留在稽核紀錄。

-- 允許以 merge_order_items 取消來源項目的單機
create or replace function app.is_legal_transition(
  p_from public.device_status,
  p_to public.device_status,
  p_action text,
  p_before_cancel public.device_status
) returns boolean language sql immutable as $$
  select case
    when p_from = 'pending_arrival' and p_to = 'arrived_pending_notify'
      then p_action = 'register_arrival'
    when p_from = 'arrived_pending_notify' and p_to = 'notified_pending_pickup'
      then p_action = 'record_notification'
    when p_from = 'notified_pending_pickup' and p_to = 'delivered'
      then p_action = 'complete_delivery'
    when p_to = 'cancelled'
      then p_from in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup', 'excluded')
       and p_action in ('cancel_device', 'cancel_order_item', 'cancel_order', 'change_item_quantity', 'merge_order_items')
    when p_action = 'correct_device_status'
      then (p_from, p_to) in (
             ('delivered'::public.device_status, 'notified_pending_pickup'::public.device_status),
             ('notified_pending_pickup', 'arrived_pending_notify'),
             ('arrived_pending_notify', 'pending_arrival'),
             ('excluded', 'pending_arrival'))
        or (p_from = 'cancelled' and p_to = p_before_cancel)
    else false
  end
$$;

create function public.merge_order_items(p_source_item_id uuid, p_target_item_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_src    public.order_items;
  v_tgt    public.order_items;
  v_reason text;
  v_n      int;
  v_next   int;
  v_dev    public.devices;
begin
  v_me := app.begin_action('merge_order_items');
  v_src := app.lock_item(p_source_item_id);
  v_tgt := app.lock_item(p_target_item_id);
  if v_src.id = v_tgt.id or v_src.order_id <> v_tgt.order_id then perform app.fail('VALIDATION', 'items'); end if;
  if row(upper(v_src.full_product_name), upper(coalesce(v_src.model, '')), coalesce(v_src.barcode, ''), coalesce(v_src.item_note, ''))
     is distinct from row(upper(v_tgt.full_product_name), upper(coalesce(v_tgt.model, '')), coalesce(v_tgt.barcode, ''), coalesce(v_tgt.item_note, '')) then
    perform app.fail('NOT_SAME_PRODUCT');
  end if;
  if exists (select 1 from public.devices where order_item_id = v_src.id and status not in ('pending_arrival', 'cancelled')) then
    perform app.fail('MERGE_NOT_ALLOWED');
  end if;

  v_reason := format('合併到第 %s 項', v_tgt.line_no);
  perform set_config('app.reason', v_reason, true);
  select count(*) into v_n from public.devices where order_item_id = v_src.id and status = 'pending_arrival';

  select coalesce(max(unit_no), 0) into v_next from public.devices where order_item_id = v_tgt.id;
  for i in 1..v_n loop
    insert into public.devices (order_id, order_item_id, unit_no, status, created_by)
    values (v_tgt.order_id, v_tgt.id, v_next + i, 'pending_arrival', v_me.user_id);
  end loop;
  update public.order_items set ordered_qty = ordered_qty + v_n where id = v_tgt.id;

  for v_dev in select * from public.devices where order_item_id = v_src.id and status <> 'cancelled' order by unit_no for update loop
    perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
  end loop;
  perform app.cascade_cancel(v_src.id, v_reason, v_me.user_id);
  return jsonb_build_object('target_item_id', v_tgt.id, 'added', v_n);
end $$;
grant execute on function public.merge_order_items(uuid, uuid) to authenticated;
