-- 產品資料（公司建檔品名）：拍照辨識後用型號找出正式品名，校正辨識錯字（決策 2026-10-25）
-- 資料由 admin 在設定頁上傳 Excel 匯入；只有已開通的同仁可以讀取，不放進公開 repo。

create table public.product_catalog (
  code             text primary key,
  product_name     text not null,
  model            text,            -- 品名最後一段型號，例如 MFYN4
  category         text,
  sub_category     text,
  detail_category  text,
  imported_at      timestamptz not null default now()
);
create index product_catalog_model on public.product_catalog (model);

alter table public.product_catalog enable row level security;
create policy read_active_users on public.product_catalog for select to authenticated
  using (app.current_role() is not null);
-- Supabase 對新資料表預設開放寫入權限，與其他資料表一致：只開放讀取，寫入只能透過 RPC
revoke all on public.product_catalog from anon, authenticated, service_role;
grant select on public.product_catalog to authenticated;

-- 品名最後一段同時含英文與數字（4–8 碼）才視為型號
create function app.model_of(p_name text)
returns text language sql immutable as $$
  select m from (select substring(btrim(p_name) from '(?:^|\s)([A-Z0-9]{4,8})$') as m) s
  where m ~ '[A-Z]' and m ~ '[0-9]'
$$;
revoke all on function app.model_of(text) from public, anon, authenticated;

-- 整批取代產品資料。資料量大，不逐筆稽核，改記一筆匯入紀錄（筆數與分類統計）。
create function public.admin_import_catalog(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.profiles;
  v_count int;
  v_stats jsonb;
begin
  v_me := app.begin_action('admin_import_catalog', 'admin');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    perform app.fail('VALIDATION', 'rows');
  end if;
  if jsonb_array_length(p_rows) > 50000 then
    perform app.fail('VALIDATION', 'too many rows');
  end if;

  delete from public.product_catalog where true;
  insert into public.product_catalog (code, product_name, model, category, sub_category, detail_category)
  select distinct on (code) code, name, app.model_of(name), app.norm_text(r ->> 'category'),
         app.norm_text(r ->> 'sub_category'), app.norm_text(r ->> 'detail_category')
  from jsonb_array_elements(p_rows) r,
       lateral (select app.norm_text(r ->> 'code') as code, app.norm_text(r ->> 'product_name') as name) n
  where code is not null and name is not null
  order by code;
  get diagnostics v_count = row_count;

  select jsonb_object_agg(coalesce(category, '（無）'), n) into v_stats
  from (select category, count(*) n from public.product_catalog group by category) s;

  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_user_id, actor_display_name, actor_db_role, after_data)
  values ('product_catalog', 'import', 'UPDATE', 'admin_import_catalog', v_me.user_id, v_me.display_name, session_user,
          jsonb_build_object('rows', v_count, 'categories', v_stats));
  return jsonb_build_object('rows', v_count, 'categories', v_stats);
end $$;
revoke all on function public.admin_import_catalog(jsonb) from public, anon;
grant execute on function public.admin_import_catalog(jsonb) to authenticated;
