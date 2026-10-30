// 同步到 Google 試算表：只有 service_role 能取得資料；內容與匯出相同（不含已取消的單機）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, createOrder, expectError } from '../lib/harness.js';

test('T80 sheet_sync_data 只給 service_role；回傳訂單、商品、單機', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');

  for (const who of ['anon', 'staffA', 'admin']) {
    assert.match(await expectError(as(db, who, 'select sheet_sync_data()')), /permission denied/);
  }
  const data = await db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return (await tx.query('select sheet_sync_data() as d')).rows[0].d;
  });
  assert.deepEqual(data.orders.map((o) => o.id), [order_id]);
  assert.ok(data.orders[0].customer_phone && data.orders[0].order_status);
  assert.ok(data.items.length >= 1 && data.items.every((i) => i.order_id === order_id));
  assert.ok(data.devices.length >= 1 && data.devices.every((d) => d.status !== 'cancelled'));
});
