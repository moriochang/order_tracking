// 待辦清單 view：只列未完成的機器；跨門市看不到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, createOrder } from '../lib/harness.js';

test('T130 待辦清單只列待到貨／待通知／待取貨；取消與交付不列；跨門市看不到', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: '示範 DEMO4', model: 'DEMO4', ordered_qty: 3 }] });
  const devs = await as(db, 'staffA', 'select id, version from devices where order_id = $1 order by unit_no', [order_id]);
  await as(db, 'staffA', 'select register_arrival($1, $2, $3)', [devs[0].id, devs[0].version, 'CW93FPXM56']);
  await as(db, 'staffA', `select cancel_device($1, $2, '顧客改買其他')`, [devs[2].id, devs[2].version]);

  const rows = await as(db, 'staffA', 'select status, model, order_no from v_device_todo order by unit_no');
  assert.deepEqual(rows.map((r) => r.status), ['arrived_pending_notify', 'pending_arrival']);
  assert.equal((await as(db, 'staffB', 'select 1 from v_device_todo')).length, 0);
});
