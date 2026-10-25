-- 改為 Google 帳號登入，只接受公司網域（決策 2026-10-25）
-- 除了白名單（profiles）外，再要求 token 內的 Email 已由 Google 驗證、與開通的帳號相同，且屬於允許的網域。

create table app.allowed_email_domains (
  domain text primary key check (domain = lower(btrim(domain)) and domain <> '')
);
insert into app.allowed_email_domains (domain) values ('istore.com.tw');
revoke all on app.allowed_email_domains from public, anon, authenticated, service_role;
alter table app.allowed_email_domains enable row level security;

create function app.email_domain_allowed(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.allowed_email_domains d
    where lower(btrim(p_email)) like '%@' || d.domain
  )
$$;

create or replace function app.current_profile()
returns public.profiles language sql stable security definer set search_path = '' as $$
  select p.*
  from public.profiles p
  where p.auth_iss = (auth.jwt() ->> 'iss')
    and p.auth_uid = (auth.jwt() ->> 'sub')
    and p.is_active
    and coalesce((auth.jwt() ->> 'email_verified')::boolean, false)
    and lower(auth.jwt() ->> 'email') = p.email
    and app.email_domain_allowed(p.email)
$$;

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
            app.norm_text(p_display_name), coalesce(p_role, 'staff'))
    returning user_id into v_user_id;
    perform app.set_user_stores(v_user_id, coalesce(p_store_codes, '{}'));
  exception
    when unique_violation or check_violation or not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('user_id', v_user_id);
end $$;

create or replace function app.bootstrap_admin(p_auth_iss text, p_auth_uid text, p_email text, p_display_name text)
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
  values (btrim(p_auth_iss), btrim(p_auth_uid), lower(btrim(p_email)), btrim(p_display_name), 'admin')
  returning user_id into v_user_id;
  return v_user_id;
end $$;

revoke all on function app.email_domain_allowed(text) from public, anon, authenticated;
revoke all on function app.bootstrap_admin(text, text, text, text) from public, anon, authenticated;
