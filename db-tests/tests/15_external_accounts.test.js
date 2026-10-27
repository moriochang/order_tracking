// 外部帳號：個人 Google 帳號經管理者開通才能登入；只能是門市檢視或門市同仁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder } from '../lib/harness.js';

test('T140 管理者開通的個人 Gmail 可登入並操作；標記為外部帳號', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const [me] = await as(db, 'extA', 'select get_me() as m');
  assert.equal(me.m.display_name, 'Tia');
  const [p] = await as(db, 'admin', `select is_external from profiles where email = 'tia.part@gmail.com'`);
  assert.equal(p.is_external, true);
  const [c] = await as(db, 'admin', `select is_external from profiles where email = 'staff.a@istore.com.tw'`);
  assert.equal(c.is_external, false);
  await createOrder(db, 'extA', { items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: 1 }] });
});

test('T141 外部帳號不能設為主管或管理者', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  assert.equal(await expectError(as(db, 'admin', 'select admin_create_user($1, $2, $3, $4, $5)',
    ['fb-ext-x', 'someone@gmail.com', null, 'manager', ['A01']])), 'EXTERNAL_ROLE_NOT_ALLOWED');
  await as(db, 'admin', 'select admin_create_user($1, $2, $3, $4, $5)', ['fb-ext-y', 'viewer.x@gmail.com', null, 'viewer', ['A01']]);
  const [{ user_id }] = await as(db, 'admin', `select user_id from profiles where email = 'tia.part@gmail.com'`);
  assert.equal(await expectError(as(db, 'admin', 'select admin_update_user($1, $2, $3)',
    [user_id, { role: 'admin' }, '升級'])), 'EXTERNAL_ROLE_NOT_ALLOWED');
});
