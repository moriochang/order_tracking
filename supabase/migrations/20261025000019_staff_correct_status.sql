-- 門市同仁也可以更正單機狀態（退回一格），原因必填（決策 2026-10-26）

create or replace function public.correct_device_status(p_device_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := app.require_reason(p_reason);
  v_dev public.devices;
begin
  perform app.begin_action('correct_device_status', 'staff', v_reason);
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
