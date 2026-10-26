-- 匯出訂單：只有主管與管理者可以匯出，每次匯出都寫入稽核紀錄（決策 2026-10-26）
-- 紀錄放在 audit_logs（不可修改、刪除）；store_code 留空，只有 admin 看得到。
-- 前端先寫入紀錄成功，才會產生檔案。

create function public.log_export(p_format text, p_orders int, p_rows int, p_filters jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_id bigint;
begin
  v_me := app.begin_action('export_orders', 'manager');
  if p_format not in ('xlsx', 'csv') then perform app.fail('VALIDATION', 'format'); end if;
  if p_orders is null or p_orders < 0 or p_rows is null or p_rows < 0 then perform app.fail('VALIDATION', 'count'); end if;
  if p_filters is not null and jsonb_typeof(p_filters) <> 'object' then perform app.fail('VALIDATION', 'filters'); end if;

  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role, after_data)
  values ('export', gen_random_uuid()::text, 'INSERT', 'export_orders', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('format', p_format, 'orders', p_orders, 'rows', p_rows, 'filters', coalesce(p_filters, '{}')))
  returning id into v_id;
  return jsonb_build_object('log_id', v_id);
end $$;
grant execute on function public.log_export(text, int, int, jsonb) to authenticated;
