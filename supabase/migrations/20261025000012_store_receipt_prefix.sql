-- 門市的「預結號碼開頭」：預結號碼前幾碼代表門市（例如 75 = 台中店 TC）。
-- 拍照辨識沒讀到門市代碼時，用預結號碼開頭判斷門市；兩者不一致時提示核對（決策 2026-10-25）

alter table public.stores
  add column receipt_prefix text unique check (receipt_prefix ~ '^[0-9]{1,4}$');

drop function public.admin_upsert_store(text, text, boolean);
create function public.admin_upsert_store(
  p_code text, p_name text, p_is_active boolean default true, p_receipt_prefix text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state text; v_constraint text; v_msg text;
begin
  perform app.begin_action('admin_upsert_store', 'admin');
  begin
    insert into public.stores (code, name, is_active, receipt_prefix)
    values (upper(app.norm_text(p_code)), app.norm_text(p_name), coalesce(p_is_active, true), app.norm_text(p_receipt_prefix))
    on conflict (code) do update set
      name = excluded.name, is_active = excluded.is_active, receipt_prefix = excluded.receipt_prefix;
  exception
    when check_violation or not_null_violation or unique_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('code', upper(app.norm_text(p_code)));
end $$;
revoke all on function public.admin_upsert_store(text, text, boolean, text) from public, anon;
grant execute on function public.admin_upsert_store(text, text, boolean, text) to authenticated;

-- 台中店（TC）的預結號碼以 75 開頭
select set_config('app.action', 'system_migration', true),
       set_config('app.reason', '設定台中店預結號碼開頭 75', true);
update public.stores set receipt_prefix = '75' where code = 'TC';
select set_config('app.action', '', true), set_config('app.reason', '', true);
