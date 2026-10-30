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

test('T81 試算表連結：管理者設定、能匯出的人取得、同步程式記錄時間', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const URL = 'https://docs.google.com/spreadsheets/d/AbC_123-x/edit';

  assert.equal(await expectError(as(db, 'managerA', 'select admin_set_sheet_link($1)', [URL])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'admin', 'select admin_set_sheet_link($1)', ['https://evil.example.com/x'])), 'VALIDATION');
  await as(db, 'admin', 'select admin_set_sheet_link($1)', [URL]);

  for (const who of ['viewerA', 'managerA', 'admin']) {
    assert.equal((await as(db, who, 'select get_sheet_link() as r'))[0].r.url, URL);
  }
  assert.equal(await expectError(as(db, 'staffA', 'select get_sheet_link()')), 'FORBIDDEN');
  assert.match(await expectError(as(db, 'anon', 'select get_sheet_link()')), /permission denied/);

  assert.match(await expectError(as(db, 'admin', 'select sheet_sync_done(3)')), /permission denied/);
  await db.transaction(async (tx) => { await tx.exec('set local role service_role'); await tx.query('select sheet_sync_done(39)'); });
  const r = (await as(db, 'viewerA', 'select get_sheet_link() as r'))[0].r;
  assert.equal(r.last_rows, 39);
  assert.ok(r.last_synced_at);

  const log = await as(db, 'admin', `select after_data from audit_logs where action = 'admin_set_sheet_link'`);
  assert.deepEqual(log[0].after_data, { sheet_url: URL });
});
