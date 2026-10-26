-- 訂單建立後依單據固定，不能再新增商品或增加數量（決策 2026-10-26）
-- 要加買請另開新訂單。減少數量（取消單機）不受影響。

revoke execute on function public.add_order_item(uuid, jsonb) from authenticated;

create or replace function public.change_item_quantity(
  p_item_id uuid, p_expected_version int, p_new_qty int,
  p_cancel_device_ids uuid[] default '{}', p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text := app.require_reason(p_reason);
  v_item   public.order_items;
  v_dev    public.devices;
  v_next   int;
  v_ids    uuid[] := coalesce(p_cancel_device_ids, '{}');
begin
  v_me := app.begin_action('change_item_quantity', 'staff', v_reason);
  v_item := app.lock_item(p_item_id, p_expected_version);

  if p_new_qty is null or p_new_qty < 1 or p_new_qty > 999 then
    perform app.fail('INVALID_QTY');
  end if;
  if p_new_qty = v_item.ordered_qty then
    perform app.fail('NO_CHANGE');
  end if;

  if p_new_qty > v_item.ordered_qty then
    perform app.fail('ADD_ITEM_NOT_ALLOWED');
    if cardinality(v_ids) > 0 then perform app.fail('VALIDATION', 'cancel_device_ids'); end if;
    select coalesce(max(unit_no), 0) into v_next from public.devices where order_item_id = p_item_id;
    for i in 1..(p_new_qty - v_item.ordered_qty) loop
      insert into public.devices (order_id, order_item_id, unit_no, status, created_by)
      values (v_item.order_id, p_item_id, v_next + i, 'pending_arrival', v_me.user_id);
    end loop;
  else
    if cardinality(v_ids) <> v_item.ordered_qty - p_new_qty
       or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
      perform app.fail('CANCEL_COUNT_MISMATCH', format('need %s devices', v_item.ordered_qty - p_new_qty));
    end if;
    for v_dev in select * from public.devices where id = any (v_ids) for update loop
      if v_dev.order_item_id <> p_item_id then perform app.fail('VALIDATION', 'device not in item'); end if;
      if v_dev.status not in ('pending_arrival', 'excluded') then
        perform app.fail('DEVICE_NOT_CANCELLABLE_FOR_QTY', v_dev.status::text);
      end if;
      perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
    end loop;
    if (select count(*) from public.devices where id = any (v_ids)) <> cardinality(v_ids) then
      perform app.fail('NOT_FOUND', 'device');
    end if;
  end if;

  update public.order_items set ordered_qty = p_new_qty where id = p_item_id returning * into v_item;
  return jsonb_build_object('item_id', v_item.id, 'version', v_item.version, 'ordered_qty', v_item.ordered_qty);
end $$;
