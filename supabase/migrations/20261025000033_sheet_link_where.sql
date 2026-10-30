-- 修正 0032：Supabase 經 API 呼叫時啟用 safeupdate，沒有 WHERE 的 UPDATE 會被拒絕
-- （「UPDATE requires a WHERE clause」），設定網址與記錄同步時間都失敗。改為指定 id = 1。

create or replace function public.admin_set_sheet_link(p_url text)
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
  select url into v_old from app.sheet_sync where id = 1 for update;
  update app.sheet_sync set url = v_url where id = 1;
  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role,
                                 before_data, after_data, changed_fields)
  values ('setting', 'sheet_link', 'UPDATE', 'admin_set_sheet_link', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('sheet_url', v_old), jsonb_build_object('sheet_url', v_url), array['sheet_url']);
  return jsonb_build_object('url', v_url);
end $$;

create or replace function public.sheet_sync_done(p_rows int)
returns void language sql security definer set search_path = '' as $$
  update app.sheet_sync set last_synced_at = now(), last_rows = p_rows where id = 1
$$;
