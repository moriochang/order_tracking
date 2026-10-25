-- 顯示名稱統一使用 Email 的 @ 前段（決策 2026-10-25），例如 morio.chang@istore.com.tw → morio.chang

create function app.email_local_part(p_email text)
returns text language sql immutable as $$ select split_part(lower(btrim(p_email)), '@', 1) $$;

create or replace function public.admin_create_user(
  p_auth_uid text, p_email text, p_display_name text,
  p_role public.app_role, p_store_codes text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_state text; v_constraint text; v_msg text;
begin
  perform app.begin_action('admin_create_user', 'admin');
  if app.norm_text(p_auth_uid) is null then perform app.fail('VALIDATION', 'auth_uid'); end if;
  if not app.email_domain_allowed(p_email) then perform app.fail('DOMAIN_NOT_ALLOWED', p_email); end if;
  begin
    insert into public.profiles (auth_iss, auth_uid, email, display_name, role)
    values (auth.jwt() ->> 'iss', btrim(p_auth_uid), lower(btrim(p_email)),
            coalesce(app.norm_text(p_display_name), app.email_local_part(p_email)),
            coalesce(p_role, 'staff'))
    returning user_id into v_user_id;
    perform app.set_user_stores(v_user_id, coalesce(p_store_codes, '{}'));
  exception
    when unique_violation or check_violation or not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('user_id', v_user_id);
end $$;

create or replace function app.bootstrap_admin(p_auth_iss text, p_auth_uid text, p_email text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
begin
  if not app.email_domain_allowed(p_email) then
    perform app.fail('DOMAIN_NOT_ALLOWED', p_email);
  end if;
  if exists (select 1 from public.profiles where role = 'admin') then
    perform app.fail('ADMIN_EXISTS');
  end if;
  perform set_config('app.action', 'bootstrap_admin', true);
  insert into public.profiles (auth_iss, auth_uid, email, display_name, role)
  values (btrim(p_auth_iss), btrim(p_auth_uid), lower(btrim(p_email)),
          coalesce(app.norm_text(p_display_name), app.email_local_part(p_email)), 'admin')
  returning user_id into v_user_id;
  return v_user_id;
end $$;

revoke all on function app.email_local_part(text) from public, anon, authenticated;

-- 既有帳號一併改為 Email 前段；以系統調整名義寫入稽核
select set_config('app.action', 'system_migration', true),
       set_config('app.reason', '顯示名稱統一改為 Email @ 前段', true);
update public.profiles set display_name = app.email_local_part(email)
where display_name is distinct from app.email_local_part(email);
select set_config('app.action', '', true), set_config('app.reason', '', true);
