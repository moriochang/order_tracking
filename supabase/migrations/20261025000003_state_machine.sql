-- 單機狀態機與資料一致性
-- 設計依據 docs/design-phase1.md §3.4
-- 這些觸發器在資料庫層強制執行，即使繞過 RPC 直接以 SQL 修改也一樣適用。

-- ── 合法狀態轉換表 ─────────────────────────────────────
create function app.is_legal_transition(
  p_from public.device_status,
  p_to public.device_status,
  p_action text,
  p_before_cancel public.device_status
) returns boolean language sql immutable as $$
  select case
    -- 正常流程
    when p_from = 'pending_arrival' and p_to = 'arrived_pending_notify'
      then p_action = 'register_arrival'
    when p_from = 'arrived_pending_notify' and p_to = 'notified_pending_pickup'
      then p_action = 'record_notification'
    when p_from = 'notified_pending_pickup' and p_to = 'delivered'
      then p_action = 'complete_delivery'
    -- 取消（已交付者不可取消）
    when p_to = 'cancelled'
      then p_from in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup', 'excluded')
       and p_action in ('cancel_device', 'cancel_order_item', 'cancel_order', 'change_item_quantity')
    -- 管理者更正：只能退回一格，或恢復取消前狀態
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

-- ── 單機守門員 ─────────────────────────────────────────
create function app.guard_device()
returns trigger language plpgsql as $$
declare
  v_action text := coalesce(nullif(current_setting('app.action', true), ''), 'direct_db_change');
begin
  if tg_op = 'INSERT' then
    -- 建立時只允許待到貨或已取走／不追蹤
    if new.status not in ('pending_arrival', 'excluded') then
      perform app.fail('ILLEGAL_INITIAL_STATUS', new.status::text);
    end if;
    if new.sn is not null or new.is_labeled or new.arrived_at is not null
       or new.last_notified_at is not null or new.delivered_at is not null then
      perform app.fail('ILLEGAL_INITIAL_STATUS', 'progress fields must be empty');
    end if;
    return new;
  end if;

  -- 不可變欄位
  if new.id <> old.id or new.order_id <> old.order_id or new.order_item_id <> old.order_item_id
     or new.unit_no <> old.unit_no or new.created_by <> old.created_by or new.created_at <> old.created_at then
    perform app.fail('IMMUTABLE_FIELD', 'devices');
  end if;

  if new.status is distinct from old.status
     and not app.is_legal_transition(old.status, new.status, v_action, old.status_before_cancel) then
    perform app.fail('ILLEGAL_TRANSITION', old.status::text || ' -> ' || new.status::text || ' via ' || v_action);
  end if;

  if new.sn is distinct from old.sn
     and v_action not in ('register_arrival', 'correct_sn', 'correct_device_status') then
    perform app.fail('ILLEGAL_FIELD_CHANGE', 'sn via ' || v_action);
  end if;

  if new.is_labeled is distinct from old.is_labeled then
    if v_action <> 'set_labeled' then
      perform app.fail('ILLEGAL_FIELD_CHANGE', 'is_labeled via ' || v_action);
    end if;
    if new.status not in ('arrived_pending_notify', 'notified_pending_pickup') then
      perform app.fail('LABEL_NOT_ALLOWED', new.status::text);
    end if;
  end if;

  if (new.excluded_at, new.excluded_by, new.exclusion_reason)
       is distinct from (old.excluded_at, old.excluded_by, old.exclusion_reason)
     and v_action <> 'correct_device_status' then
    perform app.fail('ILLEGAL_FIELD_CHANGE', 'exclusion via ' || v_action);
  end if;

  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create trigger guard before insert or update on public.devices
  for each row execute function app.guard_device();

-- ── 訂單與商品的不可變欄位 ─────────────────────────────────
create function app.guard_order()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.order_no <> old.order_no or new.store_code <> old.store_code
     or new.client_request_id <> old.client_request_id
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    perform app.fail('IMMUTABLE_FIELD', 'orders');
  end if;
  if old.cancelled_at is not null then
    perform app.fail('ORDER_CANCELLED');
  end if;
  return new;
end $$;

create trigger guard before update on public.orders
  for each row execute function app.guard_order();

create function app.guard_order_item()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.order_id <> old.order_id or new.line_no <> old.line_no
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    perform app.fail('IMMUTABLE_FIELD', 'order_items');
  end if;
  if old.cancelled_at is not null then
    perform app.fail('ITEM_CANCELLED');
  end if;
  return new;
end $$;

create trigger guard before update on public.order_items
  for each row execute function app.guard_order_item();

-- ── 數量與取消一致性（交易提交時檢查） ─────────────────────────
-- 規則：
--   未取消的商品：ordered_qty = 未取消單機數，且至少 1 台
--   已取消的商品：所有單機皆為 cancelled
--   已取消的訂單：所有商品皆已取消
--   未取消的訂單：至少一項未取消的商品
create function app.check_item_consistency(p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item   public.order_items;
  v_active int;
begin
  select * into v_item from public.order_items where id = p_item_id;
  select count(*) into v_active from public.devices
    where order_item_id = p_item_id and status <> 'cancelled';

  if v_item.cancelled_at is null then
    if v_active <> v_item.ordered_qty then
      perform app.fail('QTY_MISMATCH', format('item %s: ordered_qty=%s active_devices=%s',
                                              p_item_id, v_item.ordered_qty, v_active));
    end if;
  elsif v_active > 0 then
    perform app.fail('QTY_MISMATCH', format('cancelled item %s has %s active devices', p_item_id, v_active));
  end if;
end $$;

create function app.check_order_consistency(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders;
  v_active int;
begin
  select * into v_order from public.orders where id = p_order_id;
  select count(*) into v_active from public.order_items
    where order_id = p_order_id and cancelled_at is null;

  if v_order.cancelled_at is null and v_active = 0 then
    perform app.fail('ORDER_HAS_NO_ITEMS', p_order_id::text);
  elsif v_order.cancelled_at is not null and v_active > 0 then
    perform app.fail('ORDER_CANCEL_INCOMPLETE', p_order_id::text);
  end if;
end $$;

create function app.consistency_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  case tg_table_name
    when 'devices' then
      perform app.check_item_consistency(new.order_item_id);
    when 'order_items' then
      perform app.check_item_consistency(new.id);
      perform app.check_order_consistency(new.order_id);
    when 'orders' then
      perform app.check_order_consistency(new.id);
  end case;
  return null;
end $$;

create constraint trigger consistency after insert or update on public.devices
  deferrable initially deferred for each row execute function app.consistency_trigger();
create constraint trigger consistency after insert or update on public.order_items
  deferrable initially deferred for each row execute function app.consistency_trigger();
create constraint trigger consistency after insert or update on public.orders
  deferrable initially deferred for each row execute function app.consistency_trigger();
