-- 外部帳號（工讀生等沒有公司信箱的人，用個人 Google 帳號登入）（決策 2026-10-27）
-- 白名單就是帳號本身：只有總部管理者逐一開通的個人 Email 才能登入，並標記為外部帳號。
-- 外部帳號只能是「門市檢視」或「門市同仁」，不能設為主管或管理者。

alter table public.profiles add column is_external boolean not null default false;

create function app.guard_external_role()
returns trigger language plpgsql as $$
begin
  if new.is_external and new.role not in ('viewer', 'staff') then
    perform app.fail('EXTERNAL_ROLE_NOT_ALLOWED', new.role::text);
  end if;
  return new;
end $$;
create trigger external_role before insert or update on public.profiles
  for each row execute function app.guard_external_role();

-- 登入：公司網域，或已開通的外部帳號
create or replace function app.current_profile()
returns public.profiles language sql stable security definer set search_path = '' as $$
  select p.*
  from public.profiles p
  where p.auth_iss = (auth.jwt() ->> 'iss')
    and p.auth_uid = (auth.jwt() ->> 'sub')
    and p.is_active
    and coalesce((auth.jwt() ->> 'email_verified')::boolean, false)
    and lower(auth.jwt() ->> 'email') = p.email
    and (p.is_external or app.email_domain_allowed(p.email))
$$;

-- 開通帳號：不是公司網域的 Email 自動標記為外部帳號
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
  begin
    insert into public.profiles (auth_iss, auth_uid, email, display_name, role, is_external)
    values (auth.jwt() ->> 'iss', btrim(p_auth_uid), lower(btrim(p_email)),
            coalesce(app.norm_text(p_display_name), app.email_local_part(p_email)),
            coalesce(p_role, 'staff'), not app.email_domain_allowed(p_email))
    returning user_id into v_user_id;
    perform app.set_user_stores(v_user_id, coalesce(p_store_codes, '{}'));
  exception
    when unique_violation or check_violation or not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('user_id', v_user_id);
end $$;
