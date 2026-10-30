-- Google 試算表連結與同步狀態（決策 2026-10-30）：網址存在資料庫，不寫進公開的程式碼。
-- 管理者在「設定」填寫；能匯出的人（門市檢視、主管、管理者）在「訂單查詢」看到「開啟 Google 試算表」。
-- 同步程式（service_role）每次成功後記下時間與列數。真正控管誰能開啟的是試算表本身的共用名單。

create table app.sheet_sync (
  id             int primary key default 1 check (id = 1),
  url            text,
  last_synced_at timestamptz,
  last_rows      int
);
insert into app.sheet_sync (id) values (1);
revoke all on app.sheet_sync from public, anon, authenticated, service_role;
alter table app.sheet_sync enable row level security;

-- 能匯出的人才取得連結；門市同仁回傳 FORBIDDEN
create function public.get_sheet_link()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles := app.current_profile();
begin
  if v_me.user_id is null then perform app.fail('UNAUTHENTICATED'); end if;
  if v_me.role not in ('viewer', 'manager', 'admin') then perform app.fail('FORBIDDEN', 'sheet'); end if;
  return (select jsonb_build_object('url', url, 'last_synced_at', last_synced_at, 'last_rows', last_rows) from app.sheet_sync);
end $$;
revoke all on function public.get_sheet_link() from public, anon;
grant execute on function public.get_sheet_link() to authenticated;

-- 管理者設定網址（空白表示不顯示按鈕），留下異動紀錄
create function public.admin_set_sheet_link(p_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_url text := app.norm_text(p_url);
  v_old text;
begin
  v_me := app.begin_action('admin_set_sheet_link', 'admin');
  if v_url is not null and v_url !~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+' then
    perform app.fail('VALIDATION', 'url');
  end if;
  select url into v_old from app.sheet_sync for update;
  update app.sheet_sync set url = v_url;
  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role,
                                 before_data, after_data, changed_fields)
  values ('setting', 'sheet_link', 'UPDATE', 'admin_set_sheet_link', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('sheet_url', v_old), jsonb_build_object('sheet_url', v_url), array['sheet_url']);
  return jsonb_build_object('url', v_url);
end $$;
revoke all on function public.admin_set_sheet_link(text) from public, anon;
grant execute on function public.admin_set_sheet_link(text) to authenticated;

-- 同步程式每次成功後呼叫
create function public.sheet_sync_done(p_rows int)
returns void language sql security definer set search_path = '' as $$
  update app.sheet_sync set last_synced_at = now(), last_rows = p_rows
$$;
revoke all on function public.sheet_sync_done(int) from public, anon, authenticated;
grant execute on function public.sheet_sync_done(int) to service_role;
