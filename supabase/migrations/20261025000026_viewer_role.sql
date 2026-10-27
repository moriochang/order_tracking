-- 新角色「門市檢視」（viewer）：門市用的帳號，只能檢視與匯出訂單，不能做任何修改（決策 2026-10-27）。
-- 角色依 enum 順序代表權限高低，viewer 排在 staff 之前：所有需要 staff 以上的寫入 RPC 自動拒絕。
-- 讀取權限與同仁相同（只看得到被指派的門市）；匯出一樣先寫入稽核紀錄。

alter type public.app_role add value if not exists 'viewer' before 'staff';

-- 匯出：門市檢視、主管、管理者可以；門市同仁不行
create or replace function public.log_export(p_format text, p_orders int, p_rows int, p_filters jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_id bigint;
begin
  v_me := app.begin_action('export_orders', 'viewer');
  if v_me.role = 'staff' then perform app.fail('FORBIDDEN', 'export'); end if;
  if p_format not in ('xlsx', 'csv') then perform app.fail('VALIDATION', 'format'); end if;
  if p_orders is null or p_orders < 0 or p_rows is null or p_rows < 0 then perform app.fail('VALIDATION', 'count'); end if;
  if p_filters is not null and jsonb_typeof(p_filters) <> 'object' then perform app.fail('VALIDATION', 'filters'); end if;

  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role, after_data)
  values ('export', gen_random_uuid()::text, 'INSERT', 'export_orders', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('format', p_format, 'orders', p_orders, 'rows', p_rows, 'filters', coalesce(p_filters, '{}')))
  returning id into v_id;
  return jsonb_build_object('log_id', v_id);
end $$;
