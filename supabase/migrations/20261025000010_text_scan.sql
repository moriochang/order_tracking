-- 掃描明細（文字）：iPhone「掃描文字」／原況文字取得單據文字，於瀏覽器依規則解析，人工核對後建立訂單（決策 2026-10-25）
-- 不上傳圖片。原始掃描文字與解析結果存成草稿，與訂單在同一筆交易建立，方便日後追查。

alter table public.import_drafts
  alter column image_storage_path drop not null,
  add column source_kind text not null default 'image' check (source_kind in ('image', 'text')),
  add column raw_text text check (length(raw_text) <= 20000),
  add constraint import_drafts_source_check check (
    (source_kind = 'image' and image_storage_path is not null)
    or (source_kind = 'text' and raw_text is not null)
  );

-- 已連結訂單的草稿：能看訂單的人就能看原始掃描文字
drop policy read_own_or_manager on public.import_drafts;
create policy read_own_or_manager on public.import_drafts for select to authenticated
  using (
    created_by = app.current_user_id()
    or (app.current_role() >= 'manager' and app.can_access_store(store_code))
    or (order_id is not null and app.can_access_order(order_id))
  );

-- create_order：p_order.scan = { raw_text, parsed } 時，同一筆交易建立草稿（已確認），
-- 並把 source = 'ocr' 的商品連到這份草稿。前端傳來的 import_draft_id 一律忽略。
create or replace function public.create_order(p_order jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me       public.profiles;
  v_store    text := app.norm_text(p_order ->> 'store_code');
  v_req      uuid;
  v_existing public.orders;
  v_order_id uuid;
  v_order_no text;
  v_receipt  text := upper(app.norm_text(p_order ->> 'receipt_no'));
  v_register text := app.norm_text(p_order ->> 'register_no');
  v_seq      text := app.norm_text(p_order ->> 'receipt_seq');
  v_date     date;
  v_dups     text;
  v_ack      text := app.norm_text(p_order ->> 'duplicate_ack_reason');
  v_scan     jsonb := p_order -> 'scan';
  v_draft_id uuid;
  v_item     jsonb;
  v_line     int := 0;
  v_state    text; v_constraint text; v_msg text;
begin
  v_me := app.begin_action('create_order');

  begin
    if v_store is null then perform app.fail('VALIDATION', 'store_code'); end if;
    perform app.require_store(v_store);
    if not exists (select 1 from public.stores where code = v_store and is_active) then
      perform app.fail('STORE_INACTIVE');
    end if;

    v_req := (p_order ->> 'client_request_id')::uuid;
    if v_req is null then perform app.fail('VALIDATION', 'client_request_id'); end if;

    -- 重複送出：回傳既有訂單
    select * into v_existing from public.orders where client_request_id = v_req;
    if found then
      if v_existing.created_by <> v_me.user_id then perform app.fail('DUPLICATE_SUBMIT'); end if;
      return jsonb_build_object('order_id', v_existing.id, 'order_no', v_existing.order_no, 'replayed', true);
    end if;

    v_date := (p_order ->> 'purchase_date')::date;
    if v_date is null then perform app.fail('VALIDATION', 'purchase_date'); end if;
    if v_date > (now() at time zone 'Asia/Taipei')::date then perform app.fail('VALIDATION', 'purchase_date_future'); end if;
    if v_register is null then perform app.fail('VALIDATION', 'register_no'); end if;
    if v_seq is null then perform app.fail('VALIDATION', 'receipt_seq'); end if;

    -- 重複單據
    if v_receipt is not null then
      select string_agg(order_no, ',') into v_dups from public.orders
      where store_code = v_store and receipt_no = v_receipt and cancelled_at is null;
      if v_dups is not null then perform app.fail('DUPLICATE_RECEIPT', v_dups); end if;
    end if;
    v_dups := app.find_possible_duplicates(v_store, v_register, v_seq, v_date, null);
    if v_dups is not null and v_ack is null then
      perform app.fail('POSSIBLE_DUPLICATE', v_dups);
    end if;

    if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 then
      perform app.fail('ITEMS_REQUIRED');
    end if;

    if v_scan is not null and (jsonb_typeof(v_scan) <> 'object'
        or app.norm_text(v_scan ->> 'raw_text') is null
        or (v_scan ? 'parsed' and jsonb_typeof(v_scan -> 'parsed') <> 'object')) then
      perform app.fail('VALIDATION', 'scan');
    end if;

    v_order_no := app.next_order_no(v_store);
    insert into public.orders (
      order_no, store_code, customer_name, customer_phone, customer_code, purchase_date,
      register_no, receipt_seq, receipt_no, order_note, duplicate_ack_reason,
      client_request_id, created_by
    ) values (
      v_order_no, v_store,
      app.norm_text(p_order ->> 'customer_name'),
      app.norm_phone(p_order ->> 'customer_phone'),
      app.norm_text(p_order ->> 'customer_code'),
      v_date, v_register, v_seq, v_receipt,
      app.norm_text(p_order ->> 'order_note'),
      case when v_dups is not null then v_ack end,
      v_req, v_me.user_id
    ) returning id into v_order_id;

    if v_scan is not null then
      insert into public.import_drafts (
        store_code, source_kind, raw_text, parsed_fields, status, order_id,
        created_by, confirmed_at, confirmed_by
      ) values (
        v_store, 'text', v_scan ->> 'raw_text', v_scan -> 'parsed', 'confirmed', v_order_id,
        v_me.user_id, now(), v_me.user_id
      ) returning id into v_draft_id;
    end if;

    for v_item in select value from jsonb_array_elements(p_order -> 'items') loop
      v_line := v_line + 1;
      v_item := v_item - 'import_draft_id';
      if v_item ->> 'source' = 'ocr' then
        if v_draft_id is null then perform app.fail('VALIDATION', 'ocr item without scan'); end if;
        v_item := v_item || jsonb_build_object('import_draft_id', v_draft_id);
      end if;
      perform app.insert_item(v_order_id, v_line, v_item, v_me.user_id);
    end loop;
  exception
    when unique_violation or check_violation or not_null_violation or foreign_key_violation
      or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
      or numeric_value_out_of_range then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;

  return jsonb_build_object('order_id', v_order_id, 'order_no', v_order_no, 'replayed', false);
end $$;

-- 追加商品一律視為手動輸入，不能連到任何草稿
create or replace function public.add_order_item(p_order_id uuid, p_item jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.profiles;
  v_req     uuid;
  v_item_id uuid;
  v_line    int;
  v_state   text; v_constraint text; v_msg text;
begin
  v_me := app.begin_action('add_order_item');
  begin
    perform app.lock_order(p_order_id);
    v_req := (p_item ->> 'client_request_id')::uuid;
    if v_req is null then perform app.fail('VALIDATION', 'client_request_id'); end if;
    select id into v_item_id from public.order_items where client_request_id = v_req;
    if found then
      return jsonb_build_object('item_id', v_item_id, 'replayed', true);
    end if;
    select coalesce(max(line_no), 0) + 1 into v_line from public.order_items where order_id = p_order_id;
    v_item_id := app.insert_item(p_order_id, v_line,
      (p_item - 'import_draft_id') || '{"source": "manual"}', v_me.user_id);
  exception
    when unique_violation or check_violation or not_null_violation or foreign_key_violation
      or invalid_text_representation or numeric_value_out_of_range then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('item_id', v_item_id, 'replayed', false);
end $$;
