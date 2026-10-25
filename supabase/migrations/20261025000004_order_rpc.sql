-- 第一階段 RPC：建立訂單、修改訂單／商品、數量、取消
-- 設計依據 docs/design-phase1.md §3.5
-- 所有 RPC 皆為 security definer：前端沒有資料表寫入權限，只能透過這些函式異動資料。

-- ── 共用工具 ─────────────────────────────────────────
create function app.norm_text(p text)
returns text language sql immutable as $$ select nullif(btrim(p), '') $$;

create function app.norm_phone(p text)
returns text language sql immutable as $$ select nullif(regexp_replace(coalesce(p, ''), '[\s()\-]', '', 'g'), '') $$;

-- 將資料庫約束錯誤轉為固定錯誤代碼
create function app.raise_db_error(p_state text, p_constraint text, p_message text)
returns void language plpgsql as $$
begin
  if p_state = '23505' then  -- unique_violation
    perform app.fail(case p_constraint
      when 'orders_receipt_no_uniq' then 'DUPLICATE_RECEIPT'
      when 'devices_sn_uniq' then 'SN_DUPLICATE'
      when 'orders_client_request_id_key' then 'DUPLICATE_SUBMIT'
      when 'order_items_client_request_id_key' then 'DUPLICATE_SUBMIT'
      when 'profiles_email_key' then 'EMAIL_EXISTS'
      when 'profiles_auth_iss_auth_uid_key' then 'AUTH_ACCOUNT_EXISTS'
      else 'DUPLICATE' end, p_constraint);
  elsif p_state in ('23514', '23502', '22P02', '22007', '22008', '22003') then  -- check / not null / 格式
    perform app.fail('VALIDATION', coalesce(nullif(p_constraint, ''), p_message));
  elsif p_state = '23503' then
    perform app.fail('VALIDATION', 'reference: ' || coalesce(p_constraint, ''));
  else
    raise exception using errcode = p_state, message = p_message;
  end if;
end $$;

create function app.next_order_no(p_store_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'Asia/Taipei')::date;
  v_seq int;
begin
  insert into app.order_no_counters (store_code, day, last_seq) values (p_store_code, v_day, 1)
  on conflict (store_code, day) do update set last_seq = app.order_no_counters.last_seq + 1
  returning last_seq into v_seq;
  return format('PO-%s-%s-%s', upper(p_store_code), to_char(v_day, 'YYYYMMDD'), lpad(v_seq::text, 4, '0'));
end $$;

-- 鎖定並檢查訂單（版本、門市權限、是否已取消）
create function app.lock_order(p_order_id uuid, p_expected_version int default null)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or not app.can_access_store(v_order.store_code) then
    perform app.fail('NOT_FOUND', 'order');
  end if;
  if v_order.cancelled_at is not null then
    perform app.fail('ORDER_CANCELLED');
  end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then
    perform app.fail('STATE_CHANGED', format('order version %s, expected %s', v_order.version, p_expected_version));
  end if;
  return v_order;
end $$;

create function app.lock_item(p_item_id uuid, p_expected_version int default null)
returns public.order_items language plpgsql security definer set search_path = '' as $$
declare
  v_item public.order_items;
begin
  select * into v_item from public.order_items where id = p_item_id;
  if not found then
    perform app.fail('NOT_FOUND', 'item');
  end if;
  perform app.lock_order(v_item.order_id);
  select * into v_item from public.order_items where id = p_item_id for update;
  if v_item.cancelled_at is not null then
    perform app.fail('ITEM_CANCELLED');
  end if;
  if p_expected_version is not null and v_item.version <> p_expected_version then
    perform app.fail('STATE_CHANGED', format('item version %s, expected %s', v_item.version, p_expected_version));
  end if;
  return v_item;
end $$;

-- 疑似重複：同門市、同收銀機號、同單據序號、同日期的未取消訂單
create function app.find_possible_duplicates(
  p_store_code text, p_register_no text, p_receipt_seq text, p_purchase_date date, p_exclude_id uuid
) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(o.order_no, ',' order by o.created_at)
  from public.orders o
  where o.store_code = p_store_code and o.register_no = p_register_no
    and o.receipt_seq = p_receipt_seq and o.purchase_date = p_purchase_date
    and o.cancelled_at is null and o.id is distinct from p_exclude_id
$$;

-- 新增一項商品及其單機。單機初始狀態只允許 pending_arrival 或 excluded。
create function app.insert_item(p_order_id uuid, p_line_no int, p_item jsonb, p_actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid;
  v_name    text := app.norm_text(p_item ->> 'full_product_name');
  v_devices jsonb := p_item -> 'devices';
  v_qty     int;
  v_dev     jsonb;
  v_status  public.device_status;
  v_reason  text;
begin
  if v_name is null then
    perform app.fail('ITEM_NAME_REQUIRED');
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
    order_id, line_no, product_code, full_product_name, model, color,
    ordered_qty, item_note, source, import_draft_id, client_request_id, created_by
  ) values (
    p_order_id, p_line_no,
    app.norm_text(p_item ->> 'product_code'), v_name,
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

-- 取消一台單機（不檢查商品／訂單層級，由呼叫者處理）
create function app.cancel_device_row(p_device public.devices, p_reason text, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_device.status not in ('pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup', 'excluded') then
    perform app.fail('DEVICE_NOT_CANCELLABLE', p_device.status::text);
  end if;
  update public.devices set
    status = 'cancelled',
    status_before_cancel = p_device.status,
    cancelled_at = now(),
    cancelled_by = p_actor,
    cancellation_reason = p_reason
  where id = p_device.id;
end $$;

-- 商品沒有任何未取消單機時，連同商品一起取消；訂單沒有未取消商品時，連同訂單一起取消
create function app.cascade_cancel(p_item_id uuid, p_reason text, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order_id uuid;
begin
  select order_id into v_order_id from public.order_items where id = p_item_id;
  if not exists (select 1 from public.devices where order_item_id = p_item_id and status <> 'cancelled') then
    update public.order_items set cancelled_at = now(), cancelled_by = p_actor, cancellation_reason = p_reason
    where id = p_item_id and cancelled_at is null;
  end if;
  if not exists (select 1 from public.order_items where order_id = v_order_id and cancelled_at is null) then
    update public.orders set cancelled_at = now(), cancelled_by = p_actor, cancellation_reason = p_reason
    where id = v_order_id and cancelled_at is null;
  end if;
end $$;

-- ── 重複單據檢查（建立前提示用） ─────────────────────────────
create function public.check_duplicate_order(
  p_store_code text,
  p_receipt_no text,
  p_register_no text,
  p_receipt_seq text,
  p_purchase_date date,
  p_exclude_order_id uuid default null
) returns table (
  order_id uuid, order_no text, customer_name text, purchase_date date,
  register_no text, receipt_seq text, receipt_no text, match_type text
) language plpgsql stable security definer set search_path = '' as $$
begin
  if app.current_role() is null then
    perform app.fail('UNAUTHENTICATED');
  end if;
  perform app.require_store(p_store_code);
  return query
    select o.id, o.order_no, o.customer_name, o.purchase_date, o.register_no, o.receipt_seq, o.receipt_no,
           case when o.receipt_no = upper(app.norm_text(p_receipt_no)) then 'receipt_no' else 'register_seq_date' end
    from public.orders o
    where o.store_code = p_store_code
      and o.cancelled_at is null
      and o.id is distinct from p_exclude_order_id
      and (o.receipt_no = upper(app.norm_text(p_receipt_no))
           or (o.register_no = app.norm_text(p_register_no)
               and o.receipt_seq = app.norm_text(p_receipt_seq)
               and o.purchase_date = p_purchase_date))
    order by o.created_at;
end $$;

-- ── 建立訂單 ─────────────────────────────────────────
-- p_order：{ client_request_id, store_code, customer_name, customer_phone, customer_code,
--            purchase_date, register_no, receipt_seq, receipt_no, order_note, duplicate_ack_reason,
--            items: [{ full_product_name, product_code, model, color, item_note, source,
--                      ordered_qty | devices: [{ initial_status, exclusion_reason }] }] }
-- 一筆交易內建立訂單、商品、單機；稽核事件由觸發器產生。
create function public.create_order(p_order jsonb)
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

    for v_item in select value from jsonb_array_elements(p_order -> 'items') loop
      v_line := v_line + 1;
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

-- ── 修改訂單資料 ───────────────────────────────────────
create function public.update_order_info(
  p_order_id uuid, p_expected_version int, p_patch jsonb, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed text[] := array['customer_name', 'customer_phone', 'customer_code', 'purchase_date',
                            'register_no', 'receipt_seq', 'receipt_no', 'order_note', 'duplicate_ack_reason'];
  v_key     text;
  v_order   public.orders;
  v_new     public.orders;
  v_dups    text;
  v_state   text; v_constraint text; v_msg text;
begin
  perform app.begin_action('update_order_info', 'staff', p_reason);
  for v_key in select jsonb_object_keys(p_patch) loop
    if not v_key = any (v_allowed) then perform app.fail('VALIDATION', 'unknown field ' || v_key); end if;
  end loop;

  begin
    v_order := app.lock_order(p_order_id, p_expected_version);
    v_new := v_order;
    if p_patch ? 'customer_name' then v_new.customer_name := app.norm_text(p_patch ->> 'customer_name'); end if;
    if p_patch ? 'customer_phone' then v_new.customer_phone := app.norm_phone(p_patch ->> 'customer_phone'); end if;
    if p_patch ? 'customer_code' then v_new.customer_code := app.norm_text(p_patch ->> 'customer_code'); end if;
    if p_patch ? 'purchase_date' then v_new.purchase_date := (p_patch ->> 'purchase_date')::date; end if;
    if p_patch ? 'register_no' then v_new.register_no := app.norm_text(p_patch ->> 'register_no'); end if;
    if p_patch ? 'receipt_seq' then v_new.receipt_seq := app.norm_text(p_patch ->> 'receipt_seq'); end if;
    if p_patch ? 'receipt_no' then v_new.receipt_no := upper(app.norm_text(p_patch ->> 'receipt_no')); end if;
    if p_patch ? 'order_note' then v_new.order_note := app.norm_text(p_patch ->> 'order_note'); end if;

    if (v_new.register_no, v_new.receipt_seq, v_new.purchase_date)
       is distinct from (v_order.register_no, v_order.receipt_seq, v_order.purchase_date) then
      v_dups := app.find_possible_duplicates(v_order.store_code, v_new.register_no, v_new.receipt_seq,
                                             v_new.purchase_date, v_order.id);
      if v_dups is not null then
        v_new.duplicate_ack_reason := app.norm_text(p_patch ->> 'duplicate_ack_reason');
        if v_new.duplicate_ack_reason is null then perform app.fail('POSSIBLE_DUPLICATE', v_dups); end if;
      end if;
    end if;

    update public.orders set
      customer_name = v_new.customer_name, customer_phone = v_new.customer_phone,
      customer_code = v_new.customer_code, purchase_date = v_new.purchase_date,
      register_no = v_new.register_no, receipt_seq = v_new.receipt_seq,
      receipt_no = v_new.receipt_no, order_note = v_new.order_note,
      duplicate_ack_reason = v_new.duplicate_ack_reason
    where id = p_order_id
    returning * into v_new;
  exception
    when unique_violation or check_violation or not_null_violation
      or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('order_id', v_new.id, 'version', v_new.version);
end $$;

-- ── 新增商品到既有訂單 ───────────────────────────────────
create function public.add_order_item(p_order_id uuid, p_item jsonb)
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
    v_item_id := app.insert_item(p_order_id, v_line, p_item, v_me.user_id);
  exception
    when unique_violation or check_violation or not_null_violation or foreign_key_violation
      or invalid_text_representation or numeric_value_out_of_range then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
      perform app.raise_db_error(v_state, v_constraint, v_msg);
  end;
  return jsonb_build_object('item_id', v_item_id, 'replayed', false);
end $$;

-- ── 修改商品資料（數量請用 change_item_quantity） ────────────────
create function public.update_order_item(
  p_item_id uuid, p_expected_version int, p_patch jsonb, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed text[] := array['product_code', 'full_product_name', 'model', 'color', 'item_note'];
  v_key     text;
  v_item    public.order_items;
  v_state   text; v_constraint text; v_msg text;
begin
  perform app.begin_action('update_order_item', 'staff', p_reason);
  for v_key in select jsonb_object_keys(p_patch) loop
    if not v_key = any (v_allowed) then perform app.fail('VALIDATION', 'unknown field ' || v_key); end if;
  end loop;
  if p_patch ? 'full_product_name' and app.norm_text(p_patch ->> 'full_product_name') is null then
    perform app.fail('ITEM_NAME_REQUIRED');
  end if;

  begin
    v_item := app.lock_item(p_item_id, p_expected_version);
    update public.order_items set
      product_code = case when p_patch ? 'product_code' then app.norm_text(p_patch ->> 'product_code') else product_code end,
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

-- ── 修改數量 ─────────────────────────────────────────
-- 增加：補建待到貨單機。減少：必須指定要取消的單機（只能是待到貨或已取走／不追蹤）。
create function public.change_item_quantity(
  p_item_id uuid, p_expected_version int, p_new_qty int,
  p_cancel_device_ids uuid[] default '{}', p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text := app.require_reason(p_reason);
  v_item   public.order_items;
  v_dev    public.devices;
  v_next   int;
  v_ids    uuid[] := coalesce(p_cancel_device_ids, '{}');
begin
  v_me := app.begin_action('change_item_quantity', 'staff', v_reason);
  v_item := app.lock_item(p_item_id, p_expected_version);

  if p_new_qty is null or p_new_qty < 1 or p_new_qty > 999 then
    perform app.fail('INVALID_QTY');
  end if;
  if p_new_qty = v_item.ordered_qty then
    perform app.fail('NO_CHANGE');
  end if;

  if p_new_qty > v_item.ordered_qty then
    if cardinality(v_ids) > 0 then perform app.fail('VALIDATION', 'cancel_device_ids'); end if;
    select coalesce(max(unit_no), 0) into v_next from public.devices where order_item_id = p_item_id;
    for i in 1..(p_new_qty - v_item.ordered_qty) loop
      insert into public.devices (order_id, order_item_id, unit_no, status, created_by)
      values (v_item.order_id, p_item_id, v_next + i, 'pending_arrival', v_me.user_id);
    end loop;
  else
    if cardinality(v_ids) <> v_item.ordered_qty - p_new_qty
       or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
      perform app.fail('CANCEL_COUNT_MISMATCH', format('need %s devices', v_item.ordered_qty - p_new_qty));
    end if;
    for v_dev in select * from public.devices where id = any (v_ids) for update loop
      if v_dev.order_item_id <> p_item_id then perform app.fail('VALIDATION', 'device not in item'); end if;
      if v_dev.status not in ('pending_arrival', 'excluded') then
        perform app.fail('DEVICE_NOT_CANCELLABLE_FOR_QTY', v_dev.status::text);
      end if;
      perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
    end loop;
    if (select count(*) from public.devices where id = any (v_ids)) <> cardinality(v_ids) then
      perform app.fail('NOT_FOUND', 'device');
    end if;
  end if;

  update public.order_items set ordered_qty = p_new_qty where id = p_item_id returning * into v_item;
  return jsonb_build_object('item_id', v_item.id, 'version', v_item.version, 'ordered_qty', v_item.ordered_qty);
end $$;

-- ── 取消 ─────────────────────────────────────────────
-- 決策 P3：一般同仁也可以取消，原因必填。已交付的單機不能取消。

create function public.cancel_device(p_device_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text := app.require_reason(p_reason);
  v_dev    public.devices;
  v_item   public.order_items;
begin
  v_me := app.begin_action('cancel_device', 'staff', v_reason);
  select * into v_dev from public.devices where id = p_device_id;
  if not found then perform app.fail('NOT_FOUND', 'device'); end if;
  v_item := app.lock_item(v_dev.order_item_id);
  select * into v_dev from public.devices where id = p_device_id for update;
  if v_dev.version <> p_expected_version then
    perform app.fail('STATE_CHANGED', format('device version %s, expected %s', v_dev.version, p_expected_version));
  end if;

  perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
  if v_item.ordered_qty > 1 then
    update public.order_items set ordered_qty = ordered_qty - 1 where id = v_item.id;
  end if;
  perform app.cascade_cancel(v_item.id, v_reason, v_me.user_id);
  return jsonb_build_object('device_id', p_device_id);
end $$;

create function public.cancel_order_item(p_item_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text := app.require_reason(p_reason);
  v_item   public.order_items;
  v_dev    public.devices;
begin
  v_me := app.begin_action('cancel_order_item', 'staff', v_reason);
  v_item := app.lock_item(p_item_id, p_expected_version);
  if exists (select 1 from public.devices where order_item_id = p_item_id and status = 'delivered') then
    perform app.fail('HAS_DELIVERED_DEVICES');
  end if;
  for v_dev in select * from public.devices
               where order_item_id = p_item_id and status <> 'cancelled' order by unit_no for update loop
    perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
  end loop;
  perform app.cascade_cancel(p_item_id, v_reason, v_me.user_id);
  return jsonb_build_object('item_id', p_item_id);
end $$;

create function public.cancel_order(p_order_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles;
  v_reason text := app.require_reason(p_reason);
  v_dev    public.devices;
begin
  v_me := app.begin_action('cancel_order', 'staff', v_reason);
  perform app.lock_order(p_order_id, p_expected_version);
  if exists (select 1 from public.devices where order_id = p_order_id and status = 'delivered') then
    perform app.fail('HAS_DELIVERED_DEVICES');
  end if;
  for v_dev in select * from public.devices
               where order_id = p_order_id and status <> 'cancelled' order by order_item_id, unit_no for update loop
    perform app.cancel_device_row(v_dev, v_reason, v_me.user_id);
  end loop;
  update public.order_items set cancelled_at = now(), cancelled_by = v_me.user_id, cancellation_reason = v_reason
  where order_id = p_order_id and cancelled_at is null;
  update public.orders set cancelled_at = now(), cancelled_by = v_me.user_id, cancellation_reason = v_reason
  where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id);
end $$;
