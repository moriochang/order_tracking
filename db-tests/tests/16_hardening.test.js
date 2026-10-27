// 安全檢查後的修正：結帳日期固定當天、未登入不能執行函式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

test('T150 結帳日期一律為建單當天，之後不能修改', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { purchase_date: '2026-01-05' });   // 送舊日期也會改成當天
  const [o] = await as(db, 'staffA', `select purchase_date::text d from orders where id = $1`, [order_id]);
  assert.equal(o.d, today());
  assert.equal(await expectError(as(db, 'staffA', `select update_order_info($1, 1, '{"purchase_date": "2026-01-05"}', '改日期')`, [order_id])), 'PURCHASE_DATE_LOCKED');
  assert.equal(await expectError(asDbAdmin(db, `update orders set purchase_date = '2026-01-05' where id = $1`, [order_id])), 'PURCHASE_DATE_LOCKED');
});

test('T151 未登入不能執行任何函式', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  for (const sql of [
    `select register_arrival(gen_random_uuid(), 1, 'X')`,
    `select log_export('csv', 1, 1)`,
    `select device_sn_required(gen_random_uuid())`,
    `select get_me()`,
  ]) {
    const msg = await as(db, 'anon', sql).then(() => 'ok', (e) => e.message);
    assert.match(msg, /permission denied/, sql);
  }
});
