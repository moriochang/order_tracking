-- 主要商品必須登記 SN：Mac（CPU）、iPad、iPhone、Apple Watch、AirPods、HomePod 全系列（決策 2026-10-26）
-- 依商品型號比對產品資料的分類；產品資料找不到這個型號時，改用品名關鍵字判斷。配件等其他商品 SN 仍可留空。

create function app.sn_required(p_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with item as (select upper(btrim(model)) as model, full_product_name from public.order_items where id = p_item_id),
       cat as (select c.category, c.sub_category from public.product_catalog c, item where c.model = item.model)
  select case
    when exists (select 1 from cat) then exists (
      select 1 from cat where category in ('CPU', 'iPad', 'iPhone', 'Apple Watch', 'AirPods') or sub_category = 'HomePod')
    else coalesce((select full_product_name ~* '(iphone|ipad|macbook|imac|mac ?mini|mac ?studio|mac ?pro|apple ?watch|airpods|homepod|\mmb[apn]\M|\maw\M)'
                   from item), false)
  end
$$;
revoke all on function app.sn_required(uuid) from public, anon, authenticated;

-- 前端開啟登記到貨視窗時查詢這台是否必填 SN
create function public.device_sn_required(p_device_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.sn_required(d.order_item_id) from public.devices d
  where d.id = p_device_id and app.can_access_order(d.order_id)
$$;
grant execute on function public.device_sn_required(uuid) to authenticated;

create or replace function public.register_arrival(p_device_id uuid, p_expected_version int, p_sn text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_sn  text := app.norm_sn(p_sn);
  v_dev public.devices;
  v_state text; v_constraint text; v_msg text;
begin
  v_me := app.begin_action('register_arrival');
  v_dev := app.lock_device(p_device_id, p_expected_version);
  if v_dev.status <> 'pending_arrival' then perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text); end if;
  if v_sn is null and app.sn_required(v_dev.order_item_id) then perform app.fail('SN_REQUIRED'); end if;
  begin
    update public.devices set
      status = 'arrived_pending_notify', sn = v_sn, arrived_at = now(), arrived_by = v_me.user_id
    where id = p_device_id returning * into v_dev;
  exception
    when unique_violation or check_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;
