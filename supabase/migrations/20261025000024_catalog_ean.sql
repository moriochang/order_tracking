-- 產品資料加入國際條碼（Excel「14.EAN」欄）：3rd Party 配件輸入國際條碼即可帶入品名（決策 2026-10-27）
-- 統一補前導 0 成 14 碼存放，Excel 把條碼存成數字而少掉的 0、UPC 12 碼都能對上。

alter table public.product_catalog add column ean text;
create index product_catalog_ean on public.product_catalog (ean);

create function app.norm_gtin(p_code text)
returns text language sql immutable as $$
  select lpad(d, 14, '0') from (select regexp_replace(coalesce(p_code, ''), '\s', '', 'g') as d) s
  where d ~ '^(\d{8}|\d{12,14})$'
$$;
revoke all on function app.norm_gtin(text) from public, anon, authenticated;

create or replace function public.admin_import_catalog(p_rows jsonb)
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
  insert into public.product_catalog (code, product_name, model, category, sub_category, detail_category, ean)
  select distinct on (code) code, name, app.model_of(name), app.norm_text(r ->> 'category'),
         app.norm_text(r ->> 'sub_category'), app.norm_text(r ->> 'detail_category'), app.norm_gtin(r ->> 'ean')
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
