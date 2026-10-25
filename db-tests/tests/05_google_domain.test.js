// Google 登入與公司網域限制
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder, claimsOf, ISS } from '../lib/harness.js';

test('T40 token 的 Email 未經驗證時沒有任何權限', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  const unverified = claimsOf('staffA', { email_verified: false });
  assert.equal((await as(db, unverified, 'select * from orders')).length, 0);
  assert.equal((await as(db, unverified, 'select get_me() as me'))[0].me, null);
  assert.equal(await expectError(createOrder(db, unverified)), 'UNAUTHENTICATED');
});

test('T41 token 的 Email 與開通帳號不同時沒有任何權限', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  const other = claimsOf('staffA', { email: 'someone.else@istore.com.tw' });
  assert.equal((await as(db, other, 'select * from orders')).length, 0);
  const missing = claimsOf('staffA', { email: undefined });
  assert.equal((await as(db, missing, 'select get_me() as me'))[0].me, null);
});

test('T42 只能開通公司網域的帳號', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  for (const email of ['someone@gmail.com', 'x@istore.com.tw.evil.com', 'x@notistore.com.tw']) {
    const msg = await expectError(as(db, 'admin',
      `select admin_create_user('uid-x', $1, '外部人員', 'staff', '{A01}')`, [email]));
    assert.equal(msg, 'DOMAIN_NOT_ALLOWED', email);
  }
  await as(db, 'admin', `select admin_create_user('uid-new', 'New.Staff@ISTORE.com.tw', '新同仁', 'staff', '{A01}')`);
  const [p] = await as(db, 'admin', `select email from profiles where auth_uid = 'uid-new'`);
  assert.equal(p.email, 'new.staff@istore.com.tw');
});

test('T43 即使資料庫裡有外部網域的帳號（例如直接寫入），也無法使用', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await asDbAdmin(db, `insert into profiles (auth_iss, auth_uid, email, display_name, role)
                       values ($1, 'uid-gmail', 'outsider@gmail.com', '外部', 'admin')`, [ISS]);
  const outsider = { iss: ISS, sub: 'uid-gmail', role: 'authenticated', email: 'outsider@gmail.com', email_verified: true };
  assert.equal((await as(db, outsider, 'select get_me() as me'))[0].me, null);
  assert.equal((await as(db, outsider, 'select * from profiles')).length, 0);
});

test('T44 bootstrap_admin 只接受公司網域，且只能建立一次', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const bootstrap = (email) => asDbAdmin(db, `select app.bootstrap_admin($1, 'u2', $2, 'x')`, [ISS, email]);
  assert.equal(await expectError(bootstrap('a@gmail.com')), 'DOMAIN_NOT_ALLOWED');
  assert.equal(await expectError(bootstrap('a@istore.com.tw')), 'ADMIN_EXISTS');
});

test('T45 開通帳號時，顯示名稱自動使用 Email @ 前段', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', `select admin_create_user('uid-n1', 'Amy.Lin@istore.com.tw', null, 'staff', '{A01}')`);
  await as(db, 'admin', `select admin_create_user('uid-n2', 'bob.wu@istore.com.tw', '  ', 'staff', '{A01}')`);
  const rows = await as(db, 'admin', `select email, display_name from profiles where auth_uid in ('uid-n1', 'uid-n2') order by email`);
  assert.deepEqual(rows, [
    { email: 'amy.lin@istore.com.tw', display_name: 'amy.lin' },
    { email: 'bob.wu@istore.com.tw', display_name: 'bob.wu' },
  ]);
  // 稽核中的操作者姓名快照也使用這個名稱
  const { order_id } = await createOrder(db, { iss: ISS, sub: 'uid-n1', role: 'authenticated', email: 'amy.lin@istore.com.tw', email_verified: true });
  const [log] = await asDbAdmin(db, `select actor_display_name from audit_logs where order_id = $1 limit 1`, [order_id]);
  assert.equal(log.actor_display_name, 'amy.lin');
});
