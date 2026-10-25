-- 第二階段：單機作業。登記到貨（SN）、通知顧客、已貼、完成交付、單機備註、更正 SN、管理者更正狀態。
-- 狀態轉換仍由 app.guard_device 依 app.is_legal_transition 把關；這裡的函式負責權限、鎖定與欄位。

alter table public.devices add column note text check (note is null or length(note) <= 500);

insert into public.notification_methods (code, label, sort) values ('in_person', '顧客到店', 4);

-- 鎖定單機（同時鎖訂單、檢查門市權限與商品未取消），並核對版本
create function app.lock_device(p_device_id uuid, p_expected_version int default null)
returns public.devices language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices;
begin
  select * into v_dev from public.devices where id = p_device_id;
  if not found then perform app.fail('NOT_FOUND', 'device'); end if;
  perform app.lock_item(v_dev.order_item_id);
  select * into v_dev from public.devices where id = p_device_id for update;
  if p_expected_version is not null and v_dev.version <> p_expected_version then
    perform app.fail('STATE_CHANGED', format('device version %s, expected %s', v_dev.version, p_expected_version));
  end if;
  return v_dev;
end $$;

create function app.norm_sn(p_sn text)
returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p_sn, ''), '\s', '', 'g')), '')
$$;

-- 登記到貨：待到貨 → 已到貨待通知，SN 必填
create function public.register_arrival(p_device_id uuid, p_expected_version int, p_sn text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_sn  text := app.norm_sn(p_sn);
  v_dev public.devices;
  v_state text; v_constraint text; v_msg text;
begin
  v_me := app.begin_action('register_arrival');
  if v_sn is null then perform app.fail('SN_REQUIRED'); end if;
  v_dev := app.lock_device(p_device_id, p_expected_version);
  if v_dev.status <> 'pending_arrival' then perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text); end if;
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

-- 通知顧客（可多台一起）：已到貨待通知 → 已通知待取貨；已通知的再次通知只留紀錄
create function public.record_notification(p_device_ids uuid[], p_method text, p_outcome text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.profiles;
  v_batch   uuid := gen_random_uuid();
  v_success boolean;
  v_id      uuid;
  v_dev     public.devices;
  v_count   int := 0;
begin
  v_me := app.begin_action('record_notification');
  if coalesce(cardinality(p_device_ids), 0) = 0 then perform app.fail('VALIDATION', 'devices'); end if;
  if not exists (select 1 from public.notification_methods where code = p_method and is_active) then
    perform app.fail('VALIDATION', 'method');
  end if;
  select is_success into v_success from public.notification_outcomes where code = p_outcome and is_active;
  if not found then perform app.fail('VALIDATION', 'outcome'); end if;

  for v_id in select distinct unnest(p_device_ids) loop
    v_dev := app.lock_device(v_id);
    if v_dev.status not in ('arrived_pending_notify', 'notified_pending_pickup') then
      perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text);
    end if;
    insert into public.notifications (batch_id, device_id, order_id, operator_id, method, outcome, is_success, note)
    values (v_batch, v_id, v_dev.order_id, v_me.user_id, p_method, p_outcome, v_success, app.norm_text(p_note));
    update public.devices set
      last_notified_at = now(),
      status = case when v_success and status = 'arrived_pending_notify' then 'notified_pending_pickup' else status end
    where id = v_id;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('batch_id', v_batch, 'devices', v_count);
end $$;

-- 已貼（實機已留貨貼標）：只有已到貨、已通知的機器可以切換
create function public.set_labeled(p_device_id uuid, p_expected_version int, p_labeled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_dev public.devices;
begin
  v_me := app.begin_action('set_labeled');
  v_dev := app.lock_device(p_device_id, p_expected_version);
  update public.devices set
    is_labeled = p_labeled,
    labeled_at = case when p_labeled then now() end,
    labeled_by = case when p_labeled then v_me.user_id end
  where id = p_device_id returning * into v_dev;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;

-- 完成交付：已通知待取貨 → 已交付。
-- 顧客在通知前就到店時（已到貨待通知），先記一筆「顧客到店」通知再交付，兩個步驟都留紀錄。
create function public.complete_delivery(p_device_id uuid, p_expected_version int, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_dev public.devices;
begin
  v_me := app.begin_action('complete_delivery');
  v_dev := app.lock_device(p_device_id, p_expected_version);
  if v_dev.status = 'arrived_pending_notify' then
    perform set_config('app.action', 'record_notification', true);
    insert into public.notifications (batch_id, device_id, order_id, operator_id, method, outcome, is_success, note)
    values (gen_random_uuid(), p_device_id, v_dev.order_id, v_me.user_id, 'in_person', 'contacted', true, '交付時顧客到店');
    update public.devices set status = 'notified_pending_pickup', last_notified_at = now() where id = p_device_id;
    perform set_config('app.action', 'complete_delivery', true);
  elsif v_dev.status <> 'notified_pending_pickup' then
    perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text);
  end if;
  update public.devices set
    status = 'delivered', delivered_at = now(), delivered_by = v_me.user_id, delivery_note = app.norm_text(p_note)
  where id = p_device_id returning * into v_dev;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;

-- 單機備註
create function public.update_device_note(p_device_id uuid, p_expected_version int, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices;
  v_state text; v_constraint text; v_msg text;
begin
  perform app.begin_action('update_device_note');
  v_dev := app.lock_device(p_device_id, p_expected_version);
  begin
    update public.devices set note = app.norm_text(p_note) where id = p_device_id returning * into v_dev;
  exception
    when check_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;

-- 更正 SN：已登記 SN 的機器，原因必填
create function public.correct_sn(p_device_id uuid, p_expected_version int, p_sn text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := app.require_reason(p_reason);
  v_sn  text := app.norm_sn(p_sn);
  v_dev public.devices;
  v_state text; v_constraint text; v_msg text;
begin
  perform app.begin_action('correct_sn', 'staff', v_reason);
  if v_sn is null then perform app.fail('SN_REQUIRED'); end if;
  v_dev := app.lock_device(p_device_id, p_expected_version);
  if v_dev.sn is null or v_dev.status = 'cancelled' then perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text); end if;
  begin
    update public.devices set sn = v_sn where id = p_device_id returning * into v_dev;
  exception
    when unique_violation or check_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;

-- 管理者更正狀態：退回一格，或「已取走／不追蹤」改回待到貨。原因必填。
-- （已取消的機器恢復牽涉數量調整，不在此提供）
create function public.correct_device_status(p_device_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := app.require_reason(p_reason);
  v_dev public.devices;
begin
  perform app.begin_action('correct_device_status', 'manager', v_reason);
  v_dev := app.lock_device(p_device_id, p_expected_version);
  case v_dev.status
    when 'delivered' then
      update public.devices set status = 'notified_pending_pickup', delivered_at = null, delivered_by = null, delivery_note = null
      where id = p_device_id returning * into v_dev;
    when 'notified_pending_pickup' then
      update public.devices set status = 'arrived_pending_notify' where id = p_device_id returning * into v_dev;
    when 'arrived_pending_notify' then
      if v_dev.is_labeled then   -- 退回待到貨前先取消已貼（已貼只能透過 set_labeled 變更）
        perform set_config('app.action', 'set_labeled', true);
        update public.devices set is_labeled = false, labeled_at = null, labeled_by = null where id = p_device_id;
        perform set_config('app.action', 'correct_device_status', true);
      end if;
      update public.devices set status = 'pending_arrival', sn = null, arrived_at = null, arrived_by = null
      where id = p_device_id returning * into v_dev;
    when 'excluded' then
      update public.devices set status = 'pending_arrival', excluded_at = null, excluded_by = null, exclusion_reason = null
      where id = p_device_id returning * into v_dev;
    else
      perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text);
  end case;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version, 'status', v_dev.status);
end $$;

revoke all on function app.lock_device(uuid, int), app.norm_sn(text) from public, anon, authenticated;
grant execute on function
  public.register_arrival(uuid, int, text),
  public.record_notification(uuid[], text, text, text),
  public.set_labeled(uuid, int, boolean),
  public.complete_delivery(uuid, int, text),
  public.update_device_note(uuid, int, text),
  public.correct_sn(uuid, int, text, text),
  public.correct_device_status(uuid, int, text)
to authenticated;
