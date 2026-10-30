-- 到貨一律不必登記 SN（決策 2026-10-30：大量到貨時可批次登記到貨，SN 改為選填，之後可用「補登」填上）。
-- 保留函式名稱，register_arrival 與前端查詢 device_sn_required 都改為一律回傳「不必填」。

create or replace function app.sn_required(p_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select false
$$;
