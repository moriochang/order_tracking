// 合併相同商品：只在來源機器都待到貨時；目標數量增加、來源整項取消，數量一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder } from '../lib/harness.js';

const A = { full_product_name: '示範筆電 DEMO7', model: 'DEMO7', ordered_qty: 1 };

test('T110 合併兩項相同商品', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [A, A, { full_product_name: '其他 DEMO8', model: 'DEMO8', ordered_qty: 1 }] });
  const items = await as(db, 'staffA', 'select id, line_no from order_items where order_id = $1 order by line_no', [order_id]);
  assert.equal(await expectError(as(db, 'staffA', 'select merge_order_items($1, $2)', [items[2].id, items[0].id])), 'NOT_SAME_PRODUCT');
  await as(db, 'staffA', 'select merge_order_items($1, $2)', [items[1].id, items[0].id]);

  const after = await as(db, 'staffA', 'select line_no, ordered_qty, cancelled_at is not null as cancelled, cancellation_reason from order_items where order_id = $1 order by line_no', [order_id]);
  assert.deepEqual(after.slice(0, 2), [
    { line_no: 1, ordered_qty: 2, cancelled: false, cancellation_reason: null },
    { line_no: 2, ordered_qty: 1, cancelled: true, cancellation_reason: '合併到第 1 項' },
  ]);
  const units = await as(db, 'staffA', `select unit_no, status from devices where order_item_id = $1 order by unit_no`, [items[0].id]);
  assert.deepEqual(units.map((u) => [u.unit_no, u.status]), [[1, 'pending_arrival'], [2, 'pending_arrival']]);
});

test('T111 來源已到貨時不可合併', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [A, A] });
  const items = await as(db, 'staffA', 'select id from order_items where order_id = $1 order by line_no', [order_id]);
  const [d] = await as(db, 'staffA', 'select id, version from devices where order_item_id = $1', [items[1].id]);
  await as(db, 'staffA', 'select register_arrival($1, $2, $3)', [d.id, d.version, 'CW93FPXM56']);
  assert.equal(await expectError(as(db, 'staffA', 'select merge_order_items($1, $2)', [items[1].id, items[0].id])), 'MERGE_NOT_ALLOWED');
});
