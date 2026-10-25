-- 訂單編號改為「店號-收銀機號-序號」，例如 75-011-00348（決策 2026-10-25）
-- 收銀機號補滿 3 碼、序號補滿 5 碼（數字時）。同店同機同序號已有訂單時加上 -2、-3…
-- 編號由觸發器產生：建立時產生；修改收銀機號或序號時跟著更新（異動紀錄會留下前後值）。

create function app.order_no_base(p_store text, p_register text, p_seq text)
returns text language sql immutable as $$
  select upper(p_store) || '-'
      || case when p_register ~ '^[0-9]{1,2}$' then lpad(p_register, 3, '0') else upper(p_register) end || '-'
      || case when p_seq ~ '^[0-9]{1,4}$' then lpad(p_seq, 5, '0') else upper(p_seq) end
$$;

create function app.make_order_no(p_store text, p_register text, p_seq text, p_exclude uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_base text := app.order_no_base(p_store, p_register, p_seq);
  v_no   text := v_base;
  v_n    int := 1;
begin
  while exists (select 1 from public.orders where order_no = v_no and id is distinct from p_exclude) loop
    v_n := v_n + 1;
    v_no := v_base || '-' || v_n;
  end loop;
  return v_no;
end $$;

-- 編號與門市、收銀機號、序號不符時重新產生（建立時一定產生）
create function app.set_order_no()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_base text := app.order_no_base(new.store_code, new.register_no, new.receipt_seq);
begin
  if tg_op = 'INSERT' or new.order_no is null or not (
       new.order_no = v_base
       or (left(new.order_no, length(v_base) + 1) = v_base || '-' and substr(new.order_no, length(v_base) + 2) ~ '^[0-9]+$')
     ) then
    new.order_no := app.make_order_no(new.store_code, new.register_no, new.receipt_seq, new.id);
  end if;
  return new;
end $$;
revoke all on function app.order_no_base(text, text, text), app.make_order_no(text, text, text, uuid)
  from public, anon, authenticated;

-- guard（檢查不可直接修改編號）之後執行
create trigger number before insert or update on public.orders
  for each row execute function app.set_order_no();

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

    insert into public.orders (
      order_no, store_code, customer_name, customer_phone, customer_code, purchase_date,
      register_no, receipt_seq, receipt_no, order_note, duplicate_ack_reason,
      client_request_id, created_by
    ) values (
      null, v_store,   -- 訂單編號由觸發器依門市、收銀機號、序號產生
      app.norm_text(p_order ->> 'customer_name'),
      app.norm_phone(p_order ->> 'customer_phone'),
      app.norm_text(p_order ->> 'customer_code'),
      v_date, v_register, v_seq, v_receipt,
      app.norm_text(p_order ->> 'order_note'),
      case when v_dups is not null then v_ack end,
      v_req, v_me.user_id
    ) returning id, order_no into v_order_id, v_order_no;

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

-- 既有訂單改用新編號（已取消的訂單不能修改，維持原編號）
select set_config('app.action', 'system_migration', true),
       set_config('app.reason', '訂單編號改為店號-收銀機號-序號', true);
update public.orders set receipt_seq = receipt_seq where cancelled_at is null;
select set_config('app.action', '', true), set_config('app.reason', '', true);
