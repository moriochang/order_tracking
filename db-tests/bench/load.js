// 效能量測（不在 npm test 內）：灌入 N 張歷史訂單後，量各頁面查詢的時間。用法：node bench/load.js 30000
// 2026-10-31 量測：3 萬張時 0036 之前首頁 4.5 秒、訂單列表 6 秒；之後 0.03～0.14 秒（PGlite，正式環境會更快）
import { freshDb, as, createOrder } from '../lib/harness.js';

const N = Number(process.argv[2] ?? 30000);
const db = await freshDb();
const { order_id } = await createOrder(db, 'staffA', {
  items: [{ full_product_name: '示範筆電 DEMO-S1', model: 'DEMO-S1', color: '銀色', ordered_qty: 2 }] });

await db.exec(`set session_replication_role = replica;`);
const u = (k) => `md5(g::text || '${k}')::uuid`;
await db.exec(`
insert into public.orders (id, order_no, store_code, customer_name, customer_phone, purchase_date, register_no, receipt_seq,
  client_request_id, created_by, created_at, updated_at)
select ${u('o')}, 'H' || g, case when g % 2 = 0 then 'A01' else 'B02' end, '顧客' || g, '0912345678', current_date - (g / 30),
  '011', g::text, ${u('c')}, o.created_by, now() - (g || ' minutes')::interval * 48, now()
from generate_series(1, ${N}) g, public.orders o where o.id = '${order_id}';
insert into public.order_items (id, order_id, line_no, full_product_name, model, ordered_qty, source, client_request_id, created_by, created_at, updated_at)
select ${u('i')}, ${u('o')}, 1, it.full_product_name, it.model, 2, it.source, ${u('ic')}, it.created_by, now(), now()
from generate_series(1, ${N}) g, public.order_items it where it.order_id = '${order_id}';
insert into public.devices (id, order_id, order_item_id, unit_no, status, is_labeled, labeled_at, labeled_by, arrived_at, arrived_by,
  last_notified_at, delivered_at, delivered_by, created_by, created_at, updated_at)
select gen_random_uuid(), ${u('o')}, ${u('i')}, n, 'delivered', true, now(), d.created_by, now(), d.created_by,
  now(), now(), d.created_by, d.created_by, now(), now()
from generate_series(1, ${N}) g, generate_series(1, 2) n, (select created_by from public.devices limit 1) d;
insert into public.audit_logs (entity_type, entity_id, operation, action, order_id, actor_display_name, actor_db_role, after_data)
select 'device', g::text, 'UPDATE', 'complete_delivery', ${u('o')}, '王小明', 'authenticated', '{"status":"delivered"}'
from generate_series(1, ${N}) g, generate_series(1, 8) n;
set session_replication_role = origin; analyze;`);

const time = async (label, who, sql) => {
  await as(db, who, sql);
  const t0 = performance.now(); const rows = await as(db, who, sql);
  console.log(`${label.padEnd(28)} ${who.padEnd(7)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms  (${rows.length} rows)`);
};
console.log(`orders ${N + 1}`);
for (const who of ['admin', 'staffA']) {
  await time('首頁 數字', who, 'select * from v_todo_counts');
  await time('首頁/查詢 最近 100 張', who, 'select * from v_order_summary order by created_at desc limit 100');
  await time('查詢 電話', who, `select * from v_order_summary where customer_phone like '%5678%' order by created_at desc limit 100`);
  await time('待辦清單', who, 'select * from v_device_todo limit 1000');
  await time('訂單詳細 異動紀錄', who, `select * from audit_logs where order_id = '${order_id}' order by id desc`);
  await time('設定 最近 10 筆', who, `select * from audit_logs where order_id is null and action <> 'export_orders' order by id desc limit 10`);
}
const t0 = performance.now();
await db.transaction(async (tx) => { await tx.exec('set local role service_role'); await tx.query('select sheet_sync_data()'); });
console.log(`試算表同步 資料 (service) ${(performance.now() - t0).toFixed(0)} ms`);
process.exit(0);
