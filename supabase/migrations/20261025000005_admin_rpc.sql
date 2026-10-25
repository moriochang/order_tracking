-- 帳號、門市管理與目前使用者資訊
-- 設計依據 docs/design-phase1.md §2.1

-- 目前登入者的資料；帳號未開通或已停用時回傳 null（前端顯示「帳號未開通」）
create function public.get_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p.user_id is null then null else jsonb_build_object(
    'user_id', p.user_id,
    'email', p.email,
    'display_name', p.display_name,
    'role', p.role,
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name) order by s.code)
      from public.stores s
      where s.is_active
        and (p.role = 'admin' or exists (select 1 from public.user_stores us
                                         where us.user_id = p.user_id and us.store_code = s.code))
    ), '[]'::jsonb)
  ) end
  from (select (app.current_profile()).*) p
$$;

create function public.admin_upsert_store(p_code text, p_name text, p_is_active boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state text; v_constraint text; v_msg text;
begin
  perform app.begin_action('admin_upsert_store', 'admin');
  begin
    insert into public.stores (code, name, is_active)
    values (upper(app.norm_text(p_code)), app.norm_text(p_name), coalesce(p_is_active, true))
    on conflict (code) do update set name = excluded.name, is_active = excluded.is_active;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('code', upper(app.norm_text(p_code)));
end $$;

create function app.set_user_stores(p_user_id uuid, p_store_codes text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from unnest(p_store_codes) c
             where not exists (select 1 from public.stores s where s.code = c)) then
    perform app.fail('VALIDATION', 'unknown store');
  end if;
  delete from public.user_stores where user_id = p_user_id and not (store_code = any (p_store_codes));
  insert into public.user_stores (user_id, store_code)
  select p_user_id, c from unnest(p_store_codes) c
  on conflict do nothing;
end $$;

-- 由 Edge Function admin-users 在建立 Firebase 帳號後呼叫（帶 admin 本人的 token）。
-- 新帳號與呼叫者屬於同一個 Firebase 專案（auth_iss 取自呼叫者的 token）。
create function public.admin_create_user(
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

-- p_patch：{ display_name, role, is_active, store_codes }。角色、啟用、門市變更屬於高風險操作，原因必填。
create function public.admin_update_user(p_user_id uuid, p_patch jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed text[] := array['display_name', 'role', 'is_active', 'store_codes'];
  v_key  text;
  v_me   public.profiles;
  v_user public.profiles;
  v_stores text[];
begin
  v_me := app.begin_action('admin_update_user', 'admin', p_reason);
  for v_key in select jsonb_object_keys(p_patch) loop
    if not v_key = any (v_allowed) then perform app.fail('VALIDATION', 'unknown field ' || v_key); end if;
  end loop;
  if (p_patch ?| array['role', 'is_active', 'store_codes']) then
    perform app.require_reason(p_reason);
  end if;

  select * into v_user from public.profiles where user_id = p_user_id for update;
  if not found then perform app.fail('NOT_FOUND', 'user'); end if;
  if v_user.user_id = v_me.user_id and (p_patch ?| array['role', 'is_active']) then
    perform app.fail('CANNOT_MODIFY_SELF');
  end if;

  update public.profiles set
    display_name = case when p_patch ? 'display_name' then app.norm_text(p_patch ->> 'display_name') else display_name end,
    role = case when p_patch ? 'role' then (p_patch ->> 'role')::public.app_role else role end,
    is_active = case when p_patch ? 'is_active' then (p_patch ->> 'is_active')::boolean else is_active end
  where user_id = p_user_id;

  if p_patch ? 'store_codes' then
    select coalesce(array_agg(upper(x)), '{}') into v_stores from jsonb_array_elements_text(p_patch -> 'store_codes') x;
    perform app.set_user_stores(p_user_id, v_stores);
  end if;
  return jsonb_build_object('user_id', p_user_id);
end $$;

-- 建立第一位 admin。只能由資料庫管理者在 SQL Editor 執行一次（不開放給 API）。
create function app.bootstrap_admin(p_auth_iss text, p_auth_uid text, p_email text, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
begin
  if exists (select 1 from public.profiles where role = 'admin') then
    perform app.fail('ADMIN_EXISTS');
  end if;
  perform set_config('app.action', 'bootstrap_admin', true);
  insert into public.profiles (auth_iss, auth_uid, email, display_name, role)
  values (btrim(p_auth_iss), btrim(p_auth_uid), lower(btrim(p_email)), btrim(p_display_name), 'admin')
  returning user_id into v_user_id;
  return v_user_id;
end $$;
