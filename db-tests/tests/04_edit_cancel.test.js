// 修改與取消：版本衝突、數量變更、取消連動
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

const devicesOf = (db, orderId) => as(db, 'staffA',
  `select d.id, i.line_no, d.unit_no, d.status, d.version from devices d
   join order_items i on i.id = d.order_item_id where d.order_id = $1 order by i.line_no, d.unit_no`, [orderId]);

test('T30 兩人同時修改：舊版本的修改被拒絕（STATE_CHANGED）', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  await as(db, 'staffA', `select update_order_info($1, 1, '{"order_note": "A 的修改"}')`, [order_id]);
  const msg = await expectError(as(db, 'staffA2', `select update_order_info($1, 1, '{"order_note": "B 的修改"}')`, [order_id]));
  assert.equal(msg, 'STATE_CHANGED');
  const [o] = await as(db, 'staffA', 'select order_note, version from orders where id = $1', [order_id]);
  assert.deepEqual(o, { order_note: 'A 的修改', version: 2 });
});

test('T31 修改訂單不可變更門市、訂單編號等欄位', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  assert.equal(await expectError(as(db, 'staffA', `select update_order_info($1, 1, '{"store_code": "B02"}')`, [order_id])), 'VALIDATION');
  assert.equal(await expectError(asDbAdmin(db, `update orders set store_code = 'B02' where id = $1`, [order_id])), 'IMMUTABLE_FIELD');
});

test('T32 訂單建立後不能新增商品', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  const item = { client_request_id: randomUUID(), full_product_name: '示範平板 補訂', ordered_qty: 2 };
  assert.match(await expectError(as(db, 'staffA', 'select add_order_item($1, $2)', [order_id, item])), /permission denied/);
});

test('T25 數量 3 → 2：指定的單機變為已取消（不刪除），數量與單機數一致；不能增加', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: 'A', ordered_qty: 3 }] });
  const devs = await devicesOf(db, order_id);
  const [{ id: itemId }] = await as(db, 'staffA', 'select id from order_items where order_id = $1', [order_id]);

  assert.equal(await expectError(as(db, 'staffA',
    `select change_item_quantity($1, 1, 2, $2::uuid[], null)`, [itemId, [devs[1].id]])), 'REASON_REQUIRED');
  assert.equal(await expectError(as(db, 'staffA',
    `select change_item_quantity($1, 1, 2, '{}'::uuid[], '顧客少訂一台')`, [itemId])), 'CANCEL_COUNT_MISMATCH');

  await as(db, 'staffA', `select change_item_quantity($1, 1, 2, $2::uuid[], '顧客少訂一台')`, [itemId, [devs[1].id]]);
  const after = await devicesOf(db, order_id);
  assert.deepEqual(after.map((d) => [d.unit_no, d.status]), [[1, 'pending_arrival'], [2, 'cancelled'], [3, 'pending_arrival']]);
  const [item] = await as(db, 'staffA', 'select ordered_qty from order_items where id = $1', [itemId]);
  assert.equal(item.ordered_qty, 2);

  // 不能增加數量（訂單建立後依單據固定）
  assert.equal(await expectError(as(db, 'staffA', `select change_item_quantity($1, 2, 4, '{}'::uuid[], '顧客加訂')`, [itemId])), 'ADD_ITEM_NOT_ALLOWED');

  const logs = await as(db, 'staffA',
    `select entity_type, operation, reason from audit_logs where order_id = $1 and action = 'change_item_quantity' order by id`, [order_id]);
  assert.deepEqual(logs.map((l) => [l.entity_type, l.operation, l.reason]), [
    ['device', 'UPDATE', '顧客少訂一台'], ['order_item', 'UPDATE', '顧客少訂一台'],
  ]);
});

test('T25b 直接改數量而不調整單機，提交時被拒絕（QTY_MISMATCH）', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: 'A', ordered_qty: 3 }] });
  const msg = await expectError(asDbAdmin(db, `update order_items set ordered_qty = 2 where order_id = $1`, [order_id]));
  assert.equal(msg, 'QTY_MISMATCH');
});

test('T33 一般同仁可以取消訂單，必須填原因；取消後不可再修改', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', devices: [{}, { initial_status: 'excluded', exclusion_reason: '已取走' }] }],
  });
  assert.equal(await expectError(as(db, 'staffA', `select cancel_order($1, 1, '  ')`, [order_id])), 'REASON_REQUIRED');
  await as(db, 'staffA', `select cancel_order($1, 1, '顧客取消預購')`, [order_id]);

  const [o] = await as(db, 'staffA', 'select order_status, device_total, cancelled from v_order_summary where id = $1', [order_id]);
  assert.deepEqual(o, { order_status: 'cancelled', device_total: 0, cancelled: 2 });
  const devs = await as(db, 'staffA', 'select status, status_before_cancel, cancellation_reason from devices where order_id = $1 order by unit_no', [order_id]);
  assert.deepEqual(devs.map((d) => [d.status, d.status_before_cancel, d.cancellation_reason]), [
    ['cancelled', 'pending_arrival', '顧客取消預購'], ['cancelled', 'excluded', '顧客取消預購'],
  ]);
  assert.equal(await expectError(as(db, 'staffA', `select update_order_info($1, 2, '{"order_note": "x"}')`, [order_id])), 'ORDER_CANCELLED');

  const [todo] = await as(db, 'staffA', `select pending_arrival::int from v_todo_counts where store_code = 'A01'`);
  assert.equal(todo.pending_arrival, 0);
});

test('T34 取消單機：數量減一；取消最後一台時連帶取消商品與訂單', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', ordered_qty: 2 }, { full_product_name: 'B', ordered_qty: 1 }],
  });
  let devs = await devicesOf(db, order_id);
  await as(db, 'staffA', `select cancel_device($1, $2, '少一台')`, [devs[0].id, devs[0].version]);
  let items = await as(db, 'staffA', 'select line_no, ordered_qty, cancelled_at is not null as c from order_items where order_id = $1 order by line_no', [order_id]);
  assert.deepEqual(items.map((i) => [i.line_no, i.ordered_qty, i.c]), [[1, 1, false], [2, 1, false]]);

  devs = await devicesOf(db, order_id);
  await as(db, 'staffA', `select cancel_device($1, $2, '不要了')`, [devs[1].id, devs[1].version]);
  items = await as(db, 'staffA', 'select line_no, cancelled_at is not null as c from order_items where order_id = $1 order by line_no', [order_id]);
  assert.deepEqual(items.map((i) => [i.line_no, i.c]), [[1, true], [2, false]]);
  let [o] = await as(db, 'staffA', 'select order_status from v_order_summary where id = $1', [order_id]);
  assert.equal(o.order_status, 'in_progress');

  devs = await devicesOf(db, order_id);
  await as(db, 'staffA', `select cancel_device($1, $2, '全部不要了')`, [devs[2].id, devs[2].version]);
  [o] = await as(db, 'staffA', 'select order_status from v_order_summary where id = $1', [order_id]);
  assert.equal(o.order_status, 'cancelled');
});

test('T35 已交付的單機不可取消；含已交付單機的訂單不可整筆取消', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', { items: [{ full_product_name: 'A', ordered_qty: 2 }] });
  // 以資料庫層模擬第二階段流程走到已交付
  const [first] = await devicesOf(db, order_id);
  for (const [action, set] of [
    ['register_arrival', `status = 'arrived_pending_notify', sn = 'SN001', arrived_at = now(), arrived_by = created_by`],
    ['record_notification', `status = 'notified_pending_pickup', last_notified_at = now()`],
    ['complete_delivery', `status = 'delivered', delivered_at = now(), delivered_by = created_by`],
  ]) {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('app.action', $1, true)`, [action]);
      await tx.query(`update devices set ${set} where id = $1`, [first.id]);
    });
  }
  const [d] = await as(db, 'staffA', 'select version from devices where id = $1', [first.id]);
  assert.equal(await expectError(as(db, 'staffA', `select cancel_device($1, $2, 'x')`, [first.id, d.version])), 'DEVICE_NOT_CANCELLABLE');
  assert.equal(await expectError(as(db, 'staffA', `select cancel_order($1, 1, 'x')`, [order_id])), 'HAS_DELIVERED_DEVICES');
});

test('T36 跨門市不可修改或取消', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  assert.equal(await expectError(as(db, 'staffB', `select cancel_order($1, 1, 'x')`, [order_id])), 'NOT_FOUND');
  assert.equal(await expectError(as(db, 'staffB', `select update_order_info($1, 1, '{"order_note": "x"}')`, [order_id])), 'NOT_FOUND');
});
