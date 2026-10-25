-- 商品明細新增「國際條碼」（GTIN：EAN-8 / UPC-A / EAN-13 / GTIN-14），選填，在網頁上顯示（決策 2026-10-25）
-- 檢查碼驗證可以攔下手動輸入或 OCR 辨識錯一碼的情況。

create function app.is_valid_gtin(p_code text)
returns boolean language plpgsql immutable as $$
declare
  v_sum int := 0;
  v_len int;
  v_digit int;
begin
  if p_code is null or p_code !~ '^[0-9]+$' then return false; end if;
  v_len := length(p_code);
  if v_len not in (8, 12, 13, 14) then return false; end if;
  -- 由右往左（不含檢查碼），奇數位乘 3、偶數位乘 1
  for i in 1..(v_len - 1) loop
    v_digit := substr(p_code, v_len - i, 1)::int;
    v_sum := v_sum + case when i % 2 = 1 then v_digit * 3 else v_digit end;
  end loop;
  return (10 - v_sum % 10) % 10 = substr(p_code, v_len, 1)::int;
end $$;

alter table public.order_items add column barcode text
  constraint order_items_barcode_check check (barcode is null or app.is_valid_gtin(barcode));
create index order_items_barcode on public.order_items (barcode) where barcode is not null;

-- 共用：新增商品時寫入國際條碼
create or replace function app.insert_item(p_order_id uuid, p_line_no int, p_item jsonb, p_actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid;
  v_name    text := app.norm_text(p_item ->> 'full_product_name');
  v_barcode text := regexp_replace(coalesce(p_item ->> 'barcode', ''), '\s', '', 'g');
  v_devices jsonb := p_item -> 'devices';
  v_qty     int;
  v_dev     jsonb;
  v_status  public.device_status;
  v_reason  text;
begin
  if v_name is null then
    perform app.fail('ITEM_NAME_REQUIRED');
  end if;
  v_barcode := nullif(v_barcode, '');
  if v_barcode is not null and not app.is_valid_gtin(v_barcode) then
    perform app.fail('INVALID_BARCODE', v_barcode);
  end if;

  if v_devices is not null and jsonb_typeof(v_devices) <> 'array' then
    perform app.fail('VALIDATION', 'devices');
  end if;
  v_qty := coalesce((p_item ->> 'ordered_qty')::int, jsonb_array_length(v_devices));
  if v_qty is null or v_qty < 1 or v_qty > 999
     or (v_devices is not null and jsonb_array_length(v_devices) <> v_qty) then
    perform app.fail('INVALID_QTY');
  end if;

  insert into public.order_items (
    order_id, line_no, product_code, barcode, full_product_name, model, color,
    ordered_qty, item_note, source, import_draft_id, client_request_id, created_by
  ) values (
    p_order_id, p_line_no,
    app.norm_text(p_item ->> 'product_code'), v_barcode, v_name,
    app.norm_text(p_item ->> 'model'), app.norm_text(p_item ->> 'color'),
    v_qty, app.norm_text(p_item ->> 'item_note'),
    coalesce(app.norm_text(p_item ->> 'source'), 'manual')::public.item_source,
    (p_item ->> 'import_draft_id')::uuid,
    (p_item ->> 'client_request_id')::uuid,
    p_actor
  ) returning id into v_item_id;

  for i in 1..v_qty loop
    v_dev := coalesce(v_devices -> (i - 1), '{}'::jsonb);
    v_status := coalesce(app.norm_text(v_dev ->> 'initial_status'), 'pending_arrival');
    if v_status not in ('pending_arrival', 'excluded') then
      perform app.fail('ILLEGAL_INITIAL_STATUS', v_status::text);
    end if;
    v_reason := app.norm_text(v_dev ->> 'exclusion_reason');
    if v_status = 'excluded' and v_reason is null then
      perform app.fail('REASON_REQUIRED', format('item %s unit %s', p_line_no, i));
    end if;

    insert into public.devices (
      order_id, order_item_id, unit_no, status,
      excluded_at, excluded_by, exclusion_reason, created_by
    ) values (
      p_order_id, v_item_id, i, v_status,
      case when v_status = 'excluded' then now() end,
      case when v_status = 'excluded' then p_actor end,
      case when v_status = 'excluded' then v_reason end,
      p_actor
    );
  end loop;

  return v_item_id;
end $$;

-- 修改商品：可修改國際條碼
create or replace function public.update_order_item(
  p_item_id uuid, p_expected_version int, p_patch jsonb, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed text[] := array['product_code', 'barcode', 'full_product_name', 'model', 'color', 'item_note'];
  v_key     text;
  v_item    public.order_items;
  v_barcode text;
  v_state   text; v_constraint text; v_msg text;
begin
  perform app.begin_action('update_order_item', 'staff', p_reason);
  for v_key in select jsonb_object_keys(p_patch) loop
    if not v_key = any (v_allowed) then perform app.fail('VALIDATION', 'unknown field ' || v_key); end if;
  end loop;
  if p_patch ? 'full_product_name' and app.norm_text(p_patch ->> 'full_product_name') is null then
    perform app.fail('ITEM_NAME_REQUIRED');
  end if;
  v_barcode := nullif(regexp_replace(coalesce(p_patch ->> 'barcode', ''), '\s', '', 'g'), '');
  if v_barcode is not null and not app.is_valid_gtin(v_barcode) then
    perform app.fail('INVALID_BARCODE', v_barcode);
  end if;

  begin
    v_item := app.lock_item(p_item_id, p_expected_version);
    update public.order_items set
      product_code = case when p_patch ? 'product_code' then app.norm_text(p_patch ->> 'product_code') else product_code end,
      barcode = case when p_patch ? 'barcode' then v_barcode else barcode end,
      full_product_name = case when p_patch ? 'full_product_name' then app.norm_text(p_patch ->> 'full_product_name') else full_product_name end,
      model = case when p_patch ? 'model' then app.norm_text(p_patch ->> 'model') else model end,
      color = case when p_patch ? 'color' then app.norm_text(p_patch ->> 'color') else color end,
      item_note = case when p_patch ? 'item_note' then app.norm_text(p_patch ->> 'item_note') else item_note end
    where id = p_item_id
    returning * into v_item;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('item_id', v_item.id, 'version', v_item.version);
end $$;

revoke all on function app.is_valid_gtin(text) from public, anon, authenticated;
