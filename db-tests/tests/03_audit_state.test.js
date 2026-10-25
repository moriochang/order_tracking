// 稽核與狀態機：直接改資料庫、稽核不可刪改、事件內容
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

test('T20 以資料庫管理者直接跳過流程改狀態會被拒絕', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  const msg = await expectError(asDbAdmin(db,
    `update devices set status = 'delivered', delivered_at = now(), delivered_by = created_by where order_id = $1`, [order_id]));
  assert.equal(msg, 'ILLEGAL_TRANSITION');

  // 即使宣稱是到貨流程，也不能從待到貨直接跳到已交付
  const msg2 = await expectError(db.transaction(async (tx) => {
    await tx.query(`select set_config('app.action', 'register_arrival', true)`);
    await tx.query(`update devices set status = 'delivered' where order_id = $1`, [order_id]);
  }));
  assert.equal(msg2, 'ILLEGAL_TRANSITION');
});

test('T20b 狀態轉換表', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const legal = async (from, to, action, before = null) =>
    (await asDbAdmin(db, 'select app.is_legal_transition($1, $2, $3, $4) as ok', [from, to, action, before]))[0].ok;
  assert.equal(await legal('pending_arrival', 'arrived_pending_notify', 'register_arrival'), true);
  assert.equal(await legal('arrived_pending_notify', 'notified_pending_pickup', 'record_notification'), true);
  assert.equal(await legal('notified_pending_pickup', 'delivered', 'complete_delivery'), true);
  // 正確的起訖狀態，但動作不對
  assert.equal(await legal('pending_arrival', 'arrived_pending_notify', 'direct_db_change'), false);
  assert.equal(await legal('arrived_pending_notify', 'notified_pending_pickup', 'set_labeled'), false);
  assert.equal(await legal('notified_pending_pickup', 'delivered', 'register_arrival'), false);
  assert.equal(await legal('pending_arrival', 'cancelled', 'direct_db_change'), false);
  assert.equal(await legal('pending_arrival', 'notified_pending_pickup', 'record_notification'), false);
  assert.equal(await legal('pending_arrival', 'delivered', 'complete_delivery'), false);
  assert.equal(await legal('arrived_pending_notify', 'delivered', 'complete_delivery'), false);
  assert.equal(await legal('delivered', 'cancelled', 'cancel_device'), false);
  assert.equal(await legal('pending_arrival', 'excluded', 'create_order'), false);
  assert.equal(await legal('notified_pending_pickup', 'pending_arrival', 'correct_device_status'), false);
  assert.equal(await legal('delivered', 'notified_pending_pickup', 'correct_device_status'), true);
  assert.equal(await legal('cancelled', 'arrived_pending_notify', 'correct_device_status', 'arrived_pending_notify'), true);
  assert.equal(await legal('cancelled', 'delivered', 'correct_device_status', 'arrived_pending_notify'), false);
});

test('T21 繞過 API 直接以 SQL 修改，稽核記為 direct_db_change', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  await asDbAdmin(db, `update orders set order_note = '後台修改' where id = $1`, [order_id]);
  const [log] = await asDbAdmin(db,
    `select action, actor_user_id, actor_db_role, before_data, after_data, changed_fields
     from audit_logs where order_id = $1 and operation = 'UPDATE'`, [order_id]);
  assert.equal(log.action, 'direct_db_change');
  assert.equal(log.actor_user_id, null);
  assert.equal(log.actor_db_role, 'postgres');
  assert.deepEqual(log.before_data, { order_note: null });
  assert.deepEqual(log.after_data, { order_note: '後台修改' });
  assert.deepEqual(log.changed_fields, ['order_note']);
});

test('T22 建立訂單產生訂單、商品、每台單機的稽核事件，屬於同一筆交易', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', ordered_qty: 2 }, { full_product_name: 'B', ordered_qty: 1 }],
  });
  const logs = await as(db, 'staffA',
    `select entity_type, action, operation, actor_display_name, txn_id, store_code
     from audit_logs where order_id = $1 order by id`, [order_id]);
  assert.deepEqual(logs.map((l) => l.entity_type), ['order', 'order_item', 'device', 'device', 'order_item', 'device']);
  assert.ok(logs.every((l) => l.action === 'create_order' && l.operation === 'INSERT'));
  assert.ok(logs.every((l) => l.actor_display_name === '王小明' && l.store_code === 'A01'));
  assert.equal(new Set(logs.map((l) => l.txn_id)).size, 1);
});

test('T23 修改訂單資料：記錄前後值、變動欄位、操作者姓名快照與原因', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { customer_phone: '0912345678' });
  await as(db, 'staffA2', `select update_order_info($1, 1, $2, '顧客更換電話')`,
    [order_id, { customer_phone: '0922-000-111', order_note: '請下午來電' }]);

  const [log] = await as(db, 'staffA',
    `select action, actor_display_name, reason, before_data, after_data, changed_fields
     from audit_logs where order_id = $1 and operation = 'UPDATE'`, [order_id]);
  assert.equal(log.action, 'update_order_info');
  assert.equal(log.actor_display_name, '陳小華');
  assert.equal(log.reason, '顧客更換電話');
  assert.deepEqual(log.changed_fields, ['customer_phone', 'order_note']);
  assert.deepEqual(log.before_data, { customer_phone: '0912345678', order_note: null });
  assert.deepEqual(log.after_data, { customer_phone: '0922000111', order_note: '請下午來電' });
});

test('T23b 沒有實質變更的更新不產生稽核紀錄', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { order_note: '同樣內容' });
  await as(db, 'staffA', `select update_order_info($1, 1, '{"order_note": "同樣內容"}')`, [order_id]);
  const n = await asDbAdmin(db, `select count(*)::int n from audit_logs where order_id = $1 and operation = 'UPDATE'`, [order_id]);
  assert.equal(n[0].n, 0);
});

test('T24 稽核紀錄連資料庫管理者都無法修改、刪除或清空', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await createOrder(db, 'staffA');
  assert.equal(await expectError(asDbAdmin(db, `update audit_logs set reason = 'x'`)), 'AUDIT_IMMUTABLE');
  assert.equal(await expectError(asDbAdmin(db, `delete from audit_logs`)), 'AUDIT_IMMUTABLE');
  assert.equal(await expectError(asDbAdmin(db, `truncate audit_logs`)), 'AUDIT_IMMUTABLE');
});

test('T24b 訂單、商品、單機不可物理刪除', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  assert.equal(await expectError(asDbAdmin(db, `delete from devices where order_id = $1`, [order_id])), 'DELETE_NOT_ALLOWED');
  assert.equal(await expectError(asDbAdmin(db, `delete from orders where id = $1`, [order_id])), 'DELETE_NOT_ALLOWED');
  assert.equal(await expectError(asDbAdmin(db, `truncate devices cascade`)), 'DELETE_NOT_ALLOWED');
});

test('T26 SN 唯一性：大小寫視為相同；已取消單機的 SN 不佔用', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const a = await createOrder(db, 'staffA');
  const b = await createOrder(db, 'staffA');
  // 第二階段才有登記到貨 RPC，這裡以資料庫層直接驗證約束
  const arrive = (orderId, sn) => db.transaction(async (tx) => {
    await tx.query(`select set_config('app.action', 'register_arrival', true)`);
    await tx.query(`update devices set status = 'arrived_pending_notify', sn = $2, arrived_at = now(), arrived_by = created_by
                    where order_id = $1`, [orderId, sn]);
  });
  await arrive(a.order_id, 'SNTEST0001');
  assert.match(await expectError(arrive(b.order_id, 'SNTEST0001')), /devices_sn_uniq/);
  assert.match(await expectError(arrive(b.order_id, 'c02xyz123')), /devices_sn_check/); // 未正規化的 SN 會被拒絕

  const [dev] = await as(db, 'staffA', 'select version from devices where order_id = $1', [a.order_id]);
  // 只有一項商品一台單機：取消單機會連帶取消商品與訂單
  await as(db, 'staffA', `select cancel_device((select id from devices where order_id = $1), $2, '顧客退訂')`, [a.order_id, dev.version]);
  await arrive(b.order_id, 'SNTEST0001');
});
