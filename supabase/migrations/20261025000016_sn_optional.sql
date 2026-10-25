-- SN 改為選填（配件沒有 SN）；SN 不會有英文字母 O，一律視為數字 0（決策 2026-10-25）
-- 到貨時沒有登記 SN 的機器，之後可用「補登／更正 SN」補上（原因必填）。

alter table public.devices drop constraint devices_arrived_fields;
alter table public.devices add constraint devices_arrived_fields check (
  status not in ('arrived_pending_notify', 'notified_pending_pickup', 'delivered')
  or (arrived_at is not null and arrived_by is not null)
);

create or replace function app.norm_sn(p_sn text)
returns text language sql immutable as $$
  select nullif(translate(upper(regexp_replace(coalesce(p_sn, ''), '\s', '', 'g')), 'O', '0'), '')
$$;

-- 登記到貨：SN 選填
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

-- 補登／更正 SN：已到貨（含已交付）的機器，原因必填
create or replace function public.correct_sn(p_device_id uuid, p_expected_version int, p_sn text, p_reason text)
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
  if v_dev.status not in ('arrived_pending_notify', 'notified_pending_pickup', 'delivered') then
    perform app.fail('ILLEGAL_TRANSITION', v_dev.status::text);
  end if;
  begin
    update public.devices set sn = v_sn where id = p_device_id returning * into v_dev;
  exception
    when unique_violation or check_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;
