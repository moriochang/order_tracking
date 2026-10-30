// 第二階段單機作業：到貨（SN）、通知、已貼、交付、備註、更正
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

async function setup(qty = 2) {
  const db = await freshDb();
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: qty }] });
  const devs = () => as(db, 'staffA', 'select * from devices where order_id = $1 order by unit_no', [order_id]);
  return { db, order_id, devs };
}
const call = (db, who, sql, params) => as(db, who, `select ${sql} as r`, params).then((rows) => rows[0].r);

test('T100 完整流程：到貨登記 SN → 已貼 → 通知 → 交付，每步留紀錄', async (t) => {
  const { db, order_id, devs } = await setup(1); t.after(() => db.close());
  let [d] = await devs();
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [d.id, d.version, ' cw93 fpxm56 ']);
  [d] = await devs();
  assert.deepEqual([d.status, d.sn], ['arrived_pending_notify', 'CW93FPXM56']);

  await call(db, 'staffA', 'set_labeled($1, $2, true)', [d.id, d.version]);
  await call(db, 'staffA', `record_notification($1, 'phone', 'no_answer', '晚點再打')`, [[d.id]]);
  [d] = await devs();
  assert.deepEqual([d.status, d.is_labeled], ['notified_pending_pickup', true]);   // 有聯繫就算通知（決策）

  await call(db, 'staffA', 'complete_delivery($1, $2, $3, $4)', [d.id, d.version, ' a12652 ', '本人取貨']);
  [d] = await devs();
  assert.deepEqual([d.status, d.delivery_note, d.delivered_staff_no], ['delivered', '本人取貨', 'A12652']);

  const actions = (await as(db, 'staffA', `select action from audit_logs where device_id = $1 and operation = 'UPDATE' order by id`, [d.id])).map((r) => r.action);
  assert.deepEqual(actions, ['register_arrival', 'set_labeled', 'record_notification', 'complete_delivery']);
  const [{ n }] = await as(db, 'staffA', 'select count(*)::int n from notifications where order_id = $1', [order_id]);
  assert.equal(n, 1);
});

test('T101 狀態不對時拒絕；版本過期拒絕；SN 不可重複', async (t) => {
  const { db, devs } = await setup(2); t.after(() => db.close());
  let [a, b] = await devs();
  assert.equal(await expectError(call(db, 'staffA', `record_notification($1, 'phone', 'contacted')`, [[a.id]])), 'ILLEGAL_TRANSITION');
  assert.equal(await expectError(call(db, 'staffA', 'set_labeled($1, $2, true)', [a.id, a.version])), 'LABEL_NOT_ALLOWED');
  assert.equal(await expectError(call(db, 'staffA', `complete_delivery($1, $2, 'A12652')`, [a.id, a.version])), 'ILLEGAL_TRANSITION');

  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [a.id, a.version, 'SN1']);
  assert.equal(await expectError(call(db, 'staffA', 'register_arrival($1, $2, $3)', [a.id, a.version, 'SN1'])), 'STATE_CHANGED');
  assert.equal(await expectError(call(db, 'staffA', 'register_arrival($1, $2, $3)', [b.id, b.version, 'sn1'])), 'SN_DUPLICATE');
});

test('T102 顧客在通知前到店：交付時自動記一筆「顧客到店」通知', async (t) => {
  const { db, devs } = await setup(1); t.after(() => db.close());
  let [d] = await devs();
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [d.id, d.version, 'SN9']);
  [d] = await devs();
  await call(db, 'staffA', `complete_delivery($1, $2, 'A00001')`, [d.id, d.version]);
  [d] = await devs();
  assert.equal(d.status, 'delivered');
  const [n] = await as(db, 'staffA', 'select method, outcome from notifications where device_id = $1', [d.id]);
  assert.deepEqual(n, { method: 'in_person', outcome: 'contacted' });
});

test('T103 批次通知多台；跨門市不可操作；單機備註', async (t) => {
  const { db, devs } = await setup(2); t.after(() => db.close());
  for (const [i, d] of (await devs()).entries()) await call(db, 'staffA', 'register_arrival($1, $2, $3)', [d.id, d.version, `B${i}`]);
  const ids = (await devs()).map((d) => d.id);
  assert.equal(await expectError(call(db, 'staffB', `record_notification($1, 'sms', 'message_sent')`, [ids])), 'NOT_FOUND');
  const r = await call(db, 'staffA', `record_notification($1, 'sms', 'message_sent')`, [ids]);
  assert.equal(r.devices, 2);
  assert.deepEqual((await devs()).map((d) => d.status), ['notified_pending_pickup', 'notified_pending_pickup']);

  const [d] = await devs();
  await call(db, 'staffA', 'update_device_note($1, $2, $3)', [d.id, d.version, '顧客要求週末取貨']);
  assert.equal((await devs())[0].note, '顧客要求週末取貨');
});

test('T104 更正 SN 需原因；同仁可更正狀態退回一格（需原因、限自己門市）', async (t) => {
  const { db, devs } = await setup(1); t.after(() => db.close());
  let [d] = await devs();
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [d.id, d.version, 'WRONG']);
  [d] = await devs();
  await call(db, 'staffA', 'set_labeled($1, $2, true)', [d.id, d.version]);
  [d] = await devs();
  assert.equal(await expectError(call(db, 'staffA', 'correct_sn($1, $2, $3, null)', [d.id, d.version, 'CW93FPXM56'])), 'REASON_REQUIRED');
  await call(db, 'staffA', 'correct_sn($1, $2, $3, $4)', [d.id, d.version, 'CW93FPXM56', '輸入錯誤']);
  [d] = await devs();
  assert.equal(d.sn, 'CW93FPXM56');

  assert.equal(await expectError(call(db, 'staffA', 'correct_device_status($1, $2, $3)', [d.id, d.version, ' '])), 'REASON_REQUIRED');
  assert.equal(await expectError(call(db, 'staffB', 'correct_device_status($1, $2, $3)', [d.id, d.version, '登記錯台'])), 'NOT_FOUND');
  await call(db, 'staffA', 'correct_device_status($1, $2, $3)', [d.id, d.version, '登記錯台']);
  [d] = await devs();
  assert.deepEqual([d.status, d.sn, d.is_labeled], ['pending_arrival', null, false]);
  // SN 釋出後可以登記在其他機器
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [d.id, d.version, 'CW93FPXM56']);
});

test('T105 繞過 API 直接改狀態仍被擋下', async (t) => {
  const { db, devs } = await setup(1); t.after(() => db.close());
  const [d] = await devs();
  assert.equal(await expectError(asDbAdmin(db, `update devices set status = 'delivered' where id = $1`, [d.id])), 'ILLEGAL_TRANSITION');
});

test('T106 SN 選填（配件）；之後可補登；英文 O、I 視為數字 0、1', async (t) => {
  const { db, devs } = await setup(2); t.after(() => db.close());
  let [a, b] = await devs();
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [a.id, a.version, '  ']);
  [a] = await devs();
  assert.deepEqual([a.status, a.sn], ['arrived_pending_notify', null]);
  assert.equal(await expectError(call(db, 'staffA', 'correct_sn($1, $2, $3, null)', [a.id, a.version, 'X'])), 'REASON_REQUIRED');
  await call(db, 'staffA', 'correct_sn($1, $2, $3, $4)', [a.id, a.version, 'cO2nqcc6fyI7', '到貨時漏登']);
  await call(db, 'staffA', 'register_arrival($1, $2, $3)', [b.id, b.version, 'GFM2JJNLZF']);
  [a, b] = await devs();
  assert.deepEqual([a.sn, b.sn], ['C02NQCC6FY17', 'GFM2JJNLZF']);
});

test('T104 取貨必須輸入員編（A＋5 碼數字）；更正狀態退回時清除', async (t) => {
  const { db, devs } = await setup(1); t.after(() => db.close());
  let [d] = await devs();
  await call(db, 'staffA', 'register_arrival($1, $2, null)', [d.id, d.version]);
  [d] = await devs();
  for (const bad of [null, '', '12652', 'A1265', 'B12652', 'A126520']) {
    assert.equal(await expectError(call(db, 'staffA', 'complete_delivery($1, $2, $3)', [d.id, d.version, bad])), 'STAFF_NO_INVALID');
  }
  assert.equal((await devs())[0].status, 'arrived_pending_notify');
  await call(db, 'staffA', 'complete_delivery($1, $2, $3)', [d.id, d.version, 'A12652']);
  [d] = await devs();
  const [log] = await as(db, 'staffA', `select after_data from audit_logs where device_id = $1 and action = 'complete_delivery' and operation = 'UPDATE'`, [d.id]);
  assert.equal(log.after_data.delivered_staff_no, 'A12652');

  await call(db, 'staffA', `correct_device_status($1, $2, '按錯')`, [d.id, d.version]);
  [d] = await devs();
  assert.deepEqual([d.status, d.delivered_staff_no], ['notified_pending_pickup', null]);
  assert.match(await expectError(as(db, 'anon', `select complete_delivery(gen_random_uuid(), 1, 'A12652')`)), /permission denied/);
});
