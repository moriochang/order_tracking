-- 產品資料加入原廠型號（Excel「manufacture_style」欄，例如 MJY04TA/A）（決策 2026-10-30）
-- 型號優先取原廠型號去掉地區碼（TA/A、FE/A、ZP/A…）：品名後面多了字（「MQD32 專」）或品名型號打錯時，仍對得到收據上的型號。
-- 沒有原廠型號（3rd Party 的這欄是國際條碼、CTO 機種是 Z 開頭代碼）時，照舊取品名最後一段。

alter table public.product_catalog add column manufacture_style text;

-- Apple 原廠型號：5 碼型號 + 1–2 碼地區碼 + /A
create function app.model_of_style(p_style text)
returns text language sql immutable as $$
  select m from (select substring(upper(btrim(p_style)) from '^([A-Z0-9]{5})[A-Z]{1,2}/A$') as m) s
  where m ~ '[A-Z]' and m ~ '[0-9]'
$$;
revoke all on function app.model_of_style(text) from public, anon, authenticated;

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
  insert into public.product_catalog (code, product_name, model, category, sub_category, detail_category, ean, manufacture_style)
  select distinct on (code) code, name, coalesce(app.model_of_style(style), app.model_of(name)), app.norm_text(r ->> 'category'),
         app.norm_text(r ->> 'sub_category'), app.norm_text(r ->> 'detail_category'), app.norm_gtin(r ->> 'ean'), style
  from jsonb_array_elements(p_rows) r,
       lateral (select app.norm_text(r ->> 'code') as code, app.norm_text(r ->> 'product_name') as name,
                       upper(app.norm_text(r ->> 'manufacture_style')) as style) n
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
