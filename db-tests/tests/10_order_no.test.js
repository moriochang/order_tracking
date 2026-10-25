// 訂單編號：店號-收銀機號-序號；重複時加尾碼；修改機號序號時跟著更新；不可直接改
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

test('T90 編號格式與補零；同店同機同序號加尾碼', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const a = await createOrder(db, 'staffA', { register_no: '11', receipt_seq: '348' });
  assert.equal(a.order_no, 'A01-011-00348');
  // 同機同序號但不同日期（疑似重複需填原因）
  const b = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '00348', purchase_date: '2026-10-21' });
  assert.equal(b.order_no, 'A01-011-00348-2');
  const c = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '123456' });
  assert.equal(c.order_no, 'A01-011-123456');
});

test('T91 修改序號時編號跟著更新並留下紀錄；不可直接修改編號', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '348' });
  await as(db, 'staffA', `select update_order_info($1, 1, '{"receipt_seq": "349"}', '序號打錯')`, [order_id]);
  const [o] = await as(db, 'staffA', 'select order_no from orders where id = $1', [order_id]);
  assert.equal(o.order_no, 'A01-011-00349');
  const [log] = await as(db, 'staffA',
    `select changed_fields, before_data ->> 'order_no' as before, after_data ->> 'order_no' as after
     from audit_logs where order_id = $1 and entity_type = 'order' and operation = 'UPDATE'`, [order_id]);
  assert.deepEqual(log, { changed_fields: ['order_no', 'receipt_seq'], before: 'A01-011-00348', after: 'A01-011-00349' });

  assert.equal(await expectError(asDbAdmin(db, `update orders set order_no = 'X-1' where id = $1`, [order_id])), 'IMMUTABLE_FIELD');
});
