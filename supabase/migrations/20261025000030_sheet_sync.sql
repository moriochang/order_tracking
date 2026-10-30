-- 同步到 Google 試算表（Edge Function sync-sheet，決策 2026-10-30）：只給 service_role 一個唯讀函式，
-- 取得與網頁「匯出」相同的資料；資料表本身仍不開放 service_role 讀取。

create function public.sheet_sync_data()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.purchase_date desc, o.order_no desc)
      from (select id, order_no, store_code, customer_name, customer_phone, purchase_date, register_no, receipt_seq,
                   receipt_no, order_note, order_status from public.v_order_summary) o), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at, i.item_id)
      from (select item_id, order_id, full_product_name, model, barcode, created_at from public.v_item_backlog) i), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d) order by d.unit_no, d.id)
      from (select id, order_id, order_item_id, unit_no, sn, status, is_labeled, arrived_at, last_notified_at, delivered_at, note
            from public.devices where status <> 'cancelled') d), '[]'::jsonb))
$$;
revoke all on function public.sheet_sync_data() from public, anon, authenticated;
grant execute on function public.sheet_sync_data() to service_role;
