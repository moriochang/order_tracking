// 門市檢視：只能看自己門市的訂單與匯出，任何修改都被拒絕
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder } from '../lib/harness.js';

test('T130 門市檢視可讀自己門市、可匯出（留紀錄），不能建立或修改', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: 1 }] });
  await createOrder(db, 'staffB', { store_code: 'B02', items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: 1 }] });

  // 讀取：只看得到被指派的門市
  assert.equal((await as(db, 'viewerA', 'select id from orders')).length, 1);
  const [dev] = await as(db, 'viewerA', 'select id, version from devices where order_id = $1', [order_id]);

  // 修改一律拒絕
  assert.equal(await expectError(createOrder(db, 'viewerA', { items: [{ full_product_name: 'X', ordered_qty: 1 }] })), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'viewerA', 'select register_arrival($1, $2, $3)', [dev.id, dev.version, 'SN1'])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'viewerA', `select record_notification($1, 'phone', 'contacted')`, [[dev.id]])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'viewerA', 'select cancel_order($1, 1, $2)', [order_id, '測試'])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'viewerA', 'select correct_device_status($1, $2, $3)', [dev.id, dev.version, '測試'])), 'FORBIDDEN');

  // 匯出：可以，且留紀錄
  await as(db, 'viewerA', `select log_export('csv', 1, 1)`);
  const logs = await as(db, 'admin', `select actor_display_name from audit_logs where action = 'export_orders'`);
  assert.deepEqual(logs.map((l) => l.actor_display_name), ['信義檢視']);
});
