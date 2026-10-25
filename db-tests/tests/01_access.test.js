// 權限：未登入、跨門市、直接寫入資料表、停用帳號、Firebase 身分對應
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder, ISS, FIREBASE_PROJECT } from '../lib/harness.js';

const TABLES = ['stores', 'profiles', 'user_stores', 'orders', 'order_items', 'devices',
  'notifications', 'audit_logs', 'import_drafts', 'notification_outcomes'];

test('T01 未登入（anon）讀不到任何資料表', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  for (const table of TABLES) {
    const msg = await expectError(as(db, 'anon', `select * from ${table}`));
    assert.match(msg, /permission denied/, table);
  }
  const msg = await expectError(as(db, 'anon', `select create_order('{}')`));
  assert.match(msg, /permission denied/);
});

test('T02 同仁讀不到其他門市的訂單、單機與稽核紀錄', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const a = await createOrder(db, 'staffA');
  const b = await createOrder(db, 'staffB', { store_code: 'B02' });

  const ordersA = await as(db, 'staffA', 'select id from orders');
  assert.deepEqual(ordersA.map((r) => r.id), [a.order_id]);
  assert.equal((await as(db, 'staffA', 'select * from devices where order_id = $1', [b.order_id])).length, 0);
  assert.equal((await as(db, 'staffA', 'select * from audit_logs where order_id = $1', [b.order_id])).length, 0);
  assert.equal((await as(db, 'staffA', 'select * from v_order_summary where id = $1', [b.order_id])).length, 0);

  // admin 看得到全部
  assert.equal((await as(db, 'admin', 'select id from orders')).length, 2);
});

test('T02b 同仁不能在其他門市建立訂單', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  assert.equal(await expectError(createOrder(db, 'staffA', { store_code: 'B02' })), 'FORBIDDEN');
});

test('T03 同仁直接 insert/update/delete 資料表一律被拒絕', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  const attempts = [
    [`update devices set status = 'delivered' where order_id = $1`, [order_id]],
    [`update orders set customer_name = 'x' where id = $1`, [order_id]],
    [`delete from orders where id = $1`, [order_id]],
    [`delete from audit_logs`, []],
    [`update audit_logs set action = 'x'`, []],
    [`insert into stores (code, name) values ('Z9', 'x')`, []],
    [`update profiles set role = 'admin'`, []],
    [`insert into notifications (batch_id, device_id, order_id, operator_id, method, outcome, is_success)
      select gen_random_uuid(), id, order_id, created_by, 'phone', 'contacted', true from devices`, []],
  ];
  for (const [sql, params] of attempts) {
    const msg = await expectError(as(db, 'staffA', sql, params));
    assert.match(msg, /permission denied/, sql);
  }
});

test('T03b 前端無法呼叫內部函式（app schema）', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const msg = await expectError(as(db, 'staffA', `select app.begin_action('register_arrival')`));
  assert.match(msg, /permission denied/);
  const msg2 = await expectError(as(db, 'admin', `select app.bootstrap_admin('a', 'b', 'c@d', 'e')`));
  assert.match(msg2, /permission denied/);
});

test('T04 只有 admin 可以管理帳號與門市', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  assert.equal(await expectError(as(db, 'managerA', `select admin_upsert_store('C03', '新門市')`)), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'staffA',
    `select admin_create_user('x', 'x@istore.com.tw', 'x', 'admin', '{A01}')`)), 'FORBIDDEN');
});

test('T05 帳號停用後所有操作與讀取都失效', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  const [{ user_id }] = await as(db, 'admin', `select user_id from profiles where email = 'staff.a@istore.com.tw'`);
  await as(db, 'admin', `select admin_update_user($1, '{"is_active": false}', '離職')`, [user_id]);

  assert.equal((await as(db, 'staffA', 'select * from orders')).length, 0);
  assert.equal(await expectError(createOrder(db, 'staffA')), 'UNAUTHENTICATED');
  assert.equal((await as(db, 'staffA', 'select get_me() as me'))[0].me, null);
});

test('T06 Firebase 有帳號但尚未開通（profiles 查無）的人什麼都看不到', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  const stranger = { iss: ISS, aud: FIREBASE_PROJECT, sub: 'self-registered-uid', role: 'authenticated' };
  assert.equal((await as(db, stranger, 'select * from orders')).length, 0);
  assert.equal((await as(db, stranger, 'select * from stores')).length, 0);
  assert.equal(await expectError(createOrder(db, stranger)), 'UNAUTHENTICATED');
});

test('T07 其他 Firebase 專案（或 Supabase 本身）發出的同 UID token 不被接受', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  const otherProject = {
    iss: 'https://securetoken.google.com/someone-else', aud: 'someone-else', sub: 'fb-staff-a', role: 'authenticated',
  };
  assert.equal((await as(db, otherProject, 'select * from orders')).length, 0);
  assert.equal(await expectError(createOrder(db, otherProject)), 'UNAUTHENTICATED');
});

test('T08 admin 不能變更自己的角色或停用自己', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const [{ me }] = await as(db, 'admin', 'select get_me() as me');
  assert.equal(await expectError(as(db, 'admin',
    `select admin_update_user($1, '{"role": "staff"}', '測試')`, [me.user_id])), 'CANNOT_MODIFY_SELF');
});

test('T09 角色、門市變更需要原因，並寫入稽核', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const [{ user_id }] = await as(db, 'admin', `select user_id from profiles where email = 'staff.a@istore.com.tw'`);
  assert.equal(await expectError(as(db, 'admin',
    `select admin_update_user($1, '{"role": "manager"}')`, [user_id])), 'REASON_REQUIRED');
  await as(db, 'admin', `select admin_update_user($1, '{"role": "manager", "store_codes": ["A01", "B02"]}', '升任主管')`, [user_id]);
  const logs = await as(db, 'admin',
    `select entity_type, operation, reason, before_data, after_data from audit_logs
     where action = 'admin_update_user' order by id`);
  assert.deepEqual(logs.map((l) => [l.entity_type, l.operation, l.reason]), [
    ['profile', 'UPDATE', '升任主管'],
    ['user_store', 'INSERT', '升任主管'],
  ]);
  assert.deepEqual(logs[0].before_data, { role: 'staff' });
  assert.deepEqual(logs[0].after_data, { role: 'manager' });
});
