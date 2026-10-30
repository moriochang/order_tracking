-- 完成取貨必須輸入經手同仁的員編（決策 2026-10-30）：格式 A＋5 碼數字（例：A12652，與收據上的收銀員編號相同）。
-- 共用帳號（例如門市帳號）也能分辨是誰交機。員編存在單機上、寫進異動紀錄，訂單詳細頁顯示。
-- 取貨函式改為四個參數並移除舊的三參數版本，舊版網頁呼叫時會失敗，重新整理即可。

alter table public.devices add column delivered_staff_no text
  check (delivered_staff_no is null or delivered_staff_no ~ '^A[0-9]{5}$');

drop function public.complete_delivery(uuid, int, text);

create function public.complete_delivery(p_device_id uuid, p_expected_version int, p_staff_no text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.profiles;
  v_dev   public.devices;
  v_staff text := upper(app.norm_text(p_staff_no));
begin
  v_me := app.begin_action('complete_delivery');
  if v_staff is null or v_staff !~ '^A[0-9]{5}$' then perform app.fail('STAFF_NO_INVALID'); end if;
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
    status = 'delivered', delivered_at = now(), delivered_by = v_me.user_id, delivery_note = app.norm_text(p_note),
    delivered_staff_no = v_staff
  where id = p_device_id returning * into v_dev;
  return jsonb_build_object('device_id', v_dev.id, 'version', v_dev.version);
end $$;
revoke all on function public.complete_delivery(uuid, int, text, text) from public, anon;
grant execute on function public.complete_delivery(uuid, int, text, text) to authenticated;

-- 退回「已通知」時一併清除員編
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
      update public.devices set status = 'notified_pending_pickup', delivered_at = null, delivered_by = null, delivery_note = null,
             delivered_staff_no = null
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
