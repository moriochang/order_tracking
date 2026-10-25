// 依型號查欠貨：待到貨台數、已取消不列入、跨門市看不到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, createOrder } from '../lib/harness.js';

test('T95 依型號列出欠貨的訂單；取消的訂單不列入；只看得到自己門市', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const item = (qty, excluded = 0) => ({
    full_product_name: '示範手機 DEMO4', model: 'DEMO4',
    devices: Array.from({ length: qty }, (_, i) => (i < excluded
      ? { initial_status: 'excluded', exclusion_reason: '當場取走' } : { initial_status: 'pending_arrival' })),
  });
  const a = await createOrder(db, 'staffA', { receipt_seq: '1', items: [item(3, 1)] });
  await createOrder(db, 'staffA', { receipt_seq: '2', items: [{ full_product_name: '其他 DEMO5', model: 'DEMO5', ordered_qty: 1 }] });
  const c = await createOrder(db, 'staffA', { receipt_seq: '3', items: [item(1)] });
  await as(db, 'staffA', `select cancel_order($1, 1, '顧客取消')`, [c.order_id]);

  const rows = await as(db, 'staffA', `select order_no, ordered_qty, pending_arrival, excluded from v_item_backlog where model = 'DEMO4'`);
  assert.deepEqual(rows, [{ order_no: a.order_no, ordered_qty: 3, pending_arrival: 2, excluded: 1 }]);
  assert.equal((await as(db, 'staffB', `select 1 from v_item_backlog where model = 'DEMO4'`)).length, 0);
});
