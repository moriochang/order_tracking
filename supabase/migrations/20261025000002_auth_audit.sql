-- 身分判斷、操作上下文、稽核觸發器、資料保護觸發器
-- 設計依據 docs/design-phase1.md §2.1、§3.2、§3.3

-- ── 錯誤 ─────────────────────────────────────────────
-- 所有業務錯誤以固定代碼作為 message，前端據此顯示中文訊息。
create function app.fail(p_code text, p_detail text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end $$;

-- ── 目前登入者 ─────────────────────────────────────────
-- Firebase token 經 Supabase Third-Party Auth 驗證後，iss/sub 由 auth.jwt() 取得。
-- 只有在 profiles 中啟用的帳號才算有效使用者。
create function app.current_profile()
returns public.profiles language sql stable security definer set search_path = '' as $$
  select p.*
  from public.profiles p
  where p.auth_iss = (auth.jwt() ->> 'iss')
    and p.auth_uid = (auth.jwt() ->> 'sub')
    and p.is_active
$$;

create function app.current_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select (app.current_profile()).user_id
$$;

create function app.current_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select (app.current_profile()).role
$$;

create function app.can_access_store(p_store_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when app.current_role() is null then false
    when app.current_role() = 'admin' then true
    else exists (select 1 from public.user_stores us
                 where us.user_id = app.current_user_id() and us.store_code = p_store_code)
  end
$$;

create function app.can_access_order(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select app.can_access_store(o.store_code) from public.orders o where o.id = p_order_id), false)
$$;

-- ── 操作上下文 ─────────────────────────────────────────
-- 每個寫入用 RPC 開頭呼叫，驗證身分與角色，並把動作名稱、原因、操作者寫入本次交易，
-- 供稽核觸發器與狀態觸發器使用。交易結束後自動失效。
create function app.begin_action(
  p_action text,
  p_min_role public.app_role default 'staff',
  p_reason text default null
) returns public.profiles language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
begin
  v_me := app.current_profile();
  if v_me.user_id is null then
    perform app.fail('UNAUTHENTICATED');
  end if;
  if v_me.role < p_min_role then
    perform app.fail('FORBIDDEN', p_action);
  end if;
  perform set_config('app.action', p_action, true);
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), ''), true);
  perform set_config('app.actor_id', v_me.user_id::text, true);
  perform set_config('app.actor_name', v_me.display_name, true);
  return v_me;
end $$;

create function app.require_store(p_store_code text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.can_access_store(p_store_code) then
    perform app.fail('FORBIDDEN', 'store');
  end if;
end $$;

create function app.require_reason(p_reason text)
returns text language plpgsql immutable as $$
begin
  if btrim(coalesce(p_reason, '')) = '' then
    perform app.fail('REASON_REQUIRED');
  end if;
  return btrim(p_reason);
end $$;

-- ── 稽核觸發器 ─────────────────────────────────────────
-- 掛在所有業務資料表。任何寫入（包含直接以 SQL 修改）都會留下紀錄；
-- 沒有經過 app.begin_action 的寫入，action 記為 direct_db_change。
create function app.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_entity   text := tg_argv[0];
  v_old      jsonb;
  v_new      jsonb;
  v_row      jsonb;
  v_changed  text[];
  v_order_id uuid;
  v_store    text;
  v_action   text := nullif(current_setting('app.action', true), '');
  v_noise    text[] := array['updated_at', 'version'];
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old) - v_noise; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new) - v_noise; end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key;
    if v_changed is null then
      return null;   -- 沒有實質變更
    end if;
    -- 更新只保留變動欄位，避免重複保存個資
    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_old, v_new
    from unnest(v_changed) k;
  end if;

  v_order_id := case v_entity when 'order' then (v_row ->> 'id')::uuid
                              else (v_row ->> 'order_id')::uuid end;
  v_store := coalesce(v_row ->> 'store_code',
                      (select o.store_code from public.orders o where o.id = v_order_id));

  insert into public.audit_logs (
    store_code, order_id, order_item_id, device_id,
    entity_type, entity_id, operation, action,
    actor_user_id, actor_display_name, actor_db_role,
    before_data, after_data, changed_fields, reason
  ) values (
    v_store,
    v_order_id,
    case v_entity when 'order_item' then (v_row ->> 'id')::uuid
                  when 'device' then (v_row ->> 'order_item_id')::uuid end,
    case v_entity when 'device' then (v_row ->> 'id')::uuid
                  when 'notification' then (v_row ->> 'device_id')::uuid end,
    v_entity,
    coalesce(v_row ->> 'id', v_row ->> 'code',
             (v_row ->> 'user_id') || ':' || coalesce(v_row ->> 'store_code', '')),
    tg_op,
    coalesce(v_action, 'direct_db_change'),
    nullif(current_setting('app.actor_id', true), '')::uuid,
    nullif(current_setting('app.actor_name', true), ''),
    session_user,
    v_old,
    v_new,
    v_changed,
    nullif(current_setting('app.reason', true), '')
  );
  return null;
end $$;

create trigger audit after insert or update or delete on public.stores
  for each row execute function app.audit_row('store');
create trigger audit after insert or update or delete on public.profiles
  for each row execute function app.audit_row('profile');
create trigger audit after insert or update or delete on public.user_stores
  for each row execute function app.audit_row('user_store');
create trigger audit after insert or update or delete on public.orders
  for each row execute function app.audit_row('order');
create trigger audit after insert or update or delete on public.order_items
  for each row execute function app.audit_row('order_item');
create trigger audit after insert or update or delete on public.devices
  for each row execute function app.audit_row('device');
create trigger audit after insert or update or delete on public.notifications
  for each row execute function app.audit_row('notification');
create trigger audit after insert or update or delete on public.notification_methods
  for each row execute function app.audit_row('notification_method');
create trigger audit after insert or update or delete on public.notification_outcomes
  for each row execute function app.audit_row('notification_outcome');
create trigger audit after insert or update or delete on public.import_drafts
  for each row execute function app.audit_row('import_draft');

-- ── 資料保護 ─────────────────────────────────────────
-- 稽核與通知紀錄只能新增；業務資料不可物理刪除（以取消、排除代替）。
create function app.forbid_change()
returns trigger language plpgsql as $$
begin
  perform app.fail(tg_argv[0], tg_table_name || ' ' || tg_op);
  return null;
end $$;

create trigger immutable before update or delete on public.audit_logs
  for each row execute function app.forbid_change('AUDIT_IMMUTABLE');
create trigger immutable_truncate before truncate on public.audit_logs
  for each statement execute function app.forbid_change('AUDIT_IMMUTABLE');

create trigger immutable before update or delete on public.notifications
  for each row execute function app.forbid_change('NOTIFICATION_IMMUTABLE');

create trigger no_delete before delete on public.orders
  for each row execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_delete before delete on public.order_items
  for each row execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_delete before delete on public.devices
  for each row execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_delete before delete on public.profiles
  for each row execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_truncate before truncate on public.orders
  for each statement execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_truncate before truncate on public.order_items
  for each statement execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_truncate before truncate on public.devices
  for each statement execute function app.forbid_change('DELETE_NOT_ALLOWED');
create trigger no_truncate before truncate on public.notifications
  for each statement execute function app.forbid_change('DELETE_NOT_ALLOWED');

-- ── updated_at / version ─────────────────────────────────
create function app.touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if to_jsonb(new) ? 'version' then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

create trigger touch before update on public.stores for each row execute function app.touch_row();
create trigger touch before update on public.profiles for each row execute function app.touch_row();
create trigger touch before update on public.orders for each row execute function app.touch_row();
create trigger touch before update on public.order_items for each row execute function app.touch_row();
-- devices 由 app.guard_device 處理
