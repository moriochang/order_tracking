-- 用語：「交付」改稱「取貨」（決策 2026-10-27）。顧客在通知前到店時自動補記的通知備註一併改為「取貨時顧客到店」。
-- 通知紀錄不可修改（稽核），既有紀錄維持原文字。

create or replace function public.complete_delivery(p_device_id uuid, p_expected_version int, p_note text default null)
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
    values (gen_random_uuid(), p_device_id, v_dev.order_id, v_me.user_id, 'in_person', 'contacted', true, '取貨時顧客到店');
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