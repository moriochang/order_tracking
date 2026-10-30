-- 正式上線前清除測試資料（只執行一次；請在 Supabase SQL Editor 執行）
-- 清除：訂單、商品明細、單機、通知紀錄、掃描原文，以及這些訂單的異動紀錄與匯出紀錄。
-- 保留：帳號與門市指派、門市、產品資料，以及帳號／門市／產品資料的管理紀錄。
-- 異動紀錄、通知紀錄平常不可修改或刪除；這裡在同一個交易內暫停保護、清除後立即恢復，並留下一筆重置紀錄。
-- 執行前請先手動備份一次（Mac mini：~/order-tracking-backup/backup.sh）。
-- 執行後 Google 試算表同步會因資料大量減少而暫停並寄通知，屬正常：到「設定 → Google 試算表同步」按「允許下一次同步」。

begin;

create temp table keep_orders (order_no text primary key) on commit drop;
-- ▼ 要保留的訂單編號寫在 array[...] 裡，例如 array['75-011-00240', '75-012-01721']；全部清除就不用改
insert into keep_orders (order_no) select unnest(array[]::text[]);

-- 寫錯的編號直接中止，避免誤刪
do $$
declare v_missing text;
begin
  select string_agg(k.order_no, '、') into v_missing
  from keep_orders k where not exists (select 1 from public.orders o where o.order_no = k.order_no);
  if v_missing is not null then raise exception '找不到要保留的訂單：%（未做任何變更）', v_missing; end if;
end $$;

create temp table purge_orders on commit drop as
select id from public.orders where order_no not in (select order_no from keep_orders);

create temp table purge_counts on commit drop as
select (select count(*) from purge_orders) as orders,
       (select count(*) from public.devices where order_id in (select id from purge_orders)) as devices,
       (select count(*) from keep_orders) as kept;

-- 暫停保護與自動異動紀錄
alter table public.audit_logs disable trigger user;
alter table public.notifications disable trigger user;
alter table public.import_drafts disable trigger user;
alter table public.devices disable trigger user;
alter table public.order_items disable trigger user;
alter table public.orders disable trigger user;

delete from public.audit_logs where order_id in (select id from purge_orders) or entity_type = 'export';
-- 刪除順序依關聯：通知 → 單機 → 商品明細 → 掃描原文（商品明細會指向它）→ 訂單
delete from public.notifications where order_id in (select id from purge_orders);
delete from public.devices where order_id in (select id from purge_orders);
delete from public.order_items where order_id in (select id from purge_orders);
delete from public.import_drafts where order_id in (select id from purge_orders);
delete from public.orders where id in (select id from purge_orders);

-- 恢復保護
alter table public.audit_logs enable trigger user;
alter table public.notifications enable trigger user;
alter table public.import_drafts enable trigger user;
alter table public.devices enable trigger user;
alter table public.order_items enable trigger user;
alter table public.orders enable trigger user;

-- 留下重置紀錄（只有 admin 看得到）
insert into public.audit_logs (entity_type, entity_id, operation, action, actor_display_name, actor_db_role, reason, after_data)
select 'system', 'reset_test_data', 'DELETE', 'reset_test_data', 'SQL Editor', session_user, '正式上線前清除測試資料',
       jsonb_build_object('orders', orders, 'devices', devices, 'kept_orders', kept)
from purge_counts;

select orders as "已清除訂單", devices as "已清除單機", kept as "保留訂單" from purge_counts;

commit;
