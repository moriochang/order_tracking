// 讀取權限改為每次查詢只算一次（0036）：每種身分看到的訂單、明細、單機、通知，必須與原本逐筆判斷
// （can_access_store / can_access_order）完全相同。原本的判斷以資料庫管理者身分帶入同一個登入資訊計算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, createOrder, claimsOf, expectError, USERS } from '../lib/harness.js';

const TABLES = {
  orders: 'app.can_access_store(store_code)',
  order_items: 'app.can_access_order(order_id)',
  devices: 'app.can_access_order(order_id)',
  notifications: 'app.can_access_order(order_id)',
};

async function expected(db, claims, table) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims ? JSON.stringify(claims) : '']);
    return (await tx.query(`select id from public.${table} where ${TABLES[table]} order by id`)).rows.map((r) => r.id);
  });
}

test('T180 每種身分看到的訂單、明細、單機、通知與原本逐筆判斷完全相同', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', `select admin_upsert_store('C03', '台中門市')`);
  await as(db, 'admin', `select admin_create_user('fb-none', 'none@istore.com.tw', '未指派', 'staff', '{}')`);
  await as(db, 'admin', `select admin_create_user('fb-gone', 'gone@istore.com.tw', '已離職', 'staff', '{A01,B02}')`);
  const [{ user_id }] = await as(db, 'admin', `select user_id from profiles where email = 'gone@istore.com.tw'`);
  await as(db, 'admin', `select admin_update_user($1, '{"is_active": false}', '離職')`, [user_id]);

  const two = { items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: 2 }] };
  const a1 = await createOrder(db, 'staffA', two);
  await createOrder(db, 'staffA2', two);
  await createOrder(db, 'staffB', { ...two, store_code: 'B02' });
  await createOrder(db, 'admin', { ...two, store_code: 'C03' });
  const cancelled = await createOrder(db, 'staffA');
  await as(db, 'staffA', `select cancel_order($1, 1, '顧客取消')`, [cancelled.order_id]);
  const [d] = await as(db, 'staffA', 'select id, version from devices where order_id = $1 order by unit_no limit 1', [a1.order_id]);
  await as(db, 'staffA', 'select register_arrival($1, $2, null)', [d.id, d.version]);
  await as(db, 'staffA', `select record_notification($1, 'phone', 'contacted')`, [[d.id]]);

  const who = {
    ...Object.fromEntries(Object.keys(USERS).map((k) => [k, claimsOf(k)])),
    unassigned: { ...claimsOf('staffA'), sub: 'fb-none', email: 'none@istore.com.tw' },
    deactivated: { ...claimsOf('staffA'), sub: 'fb-gone', email: 'gone@istore.com.tw' },
  };
  const seen = {};
  for (const [name, claims] of Object.entries(who)) {
    for (const table of Object.keys(TABLES)) {
      const got = (await as(db, claims, `select id from ${table} order by id`)).map((r) => r.id);
      assert.deepEqual(got, await expected(db, claims, table), `${name} ${table}`);
      seen[`${name}.${table}`] = got.length;
    }
  }
  // 確認測試資料真的區分得出不同範圍
  assert.equal(seen['admin.orders'], 5);
  assert.equal(seen['staffA.orders'], 3);
  assert.equal(seen['staffB.orders'], 1);
  assert.ok(seen['staffA.notifications'] >= 1 && seen['staffB.notifications'] === 0);
  for (const k of ['unassigned', 'deactivated']) assert.equal(seen[`${k}.orders`] + seen[`${k}.devices`], 0, k);
  // 未登入本來就沒有讀取權
  for (const table of Object.keys(TABLES)) {
    assert.match(await expectError(as(db, 'anon', `select id from ${table}`)), /permission denied/);
  }
});
