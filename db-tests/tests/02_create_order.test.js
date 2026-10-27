// 建立訂單：單機筆數、初始狀態、重複單據、重複送出、文字欄位
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder, orderPayload } from '../lib/harness.js';

test('T10 每台實體機器一筆單機紀錄，unit_no 依商品各自編號', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    items: [
      { full_product_name: '示範筆電 13 吋 8G 256GB 粉色 DEMO-P1', ordered_qty: 3 },
      { full_product_name: '示範筆電 13 吋 8G 256GB 銀色 DEMO-S1', ordered_qty: 2 },
    ],
  });
  const devices = await as(db, 'staffA', `
    select i.line_no, i.full_product_name, d.unit_no, d.status, d.sn
    from devices d join order_items i on i.id = d.order_item_id
    where d.order_id = $1 order by i.line_no, d.unit_no`, [order_id]);
  assert.deepEqual(devices.map((d) => [d.line_no, d.unit_no, d.status, d.sn]), [
    [1, 1, 'pending_arrival', null], [1, 2, 'pending_arrival', null], [1, 3, 'pending_arrival', null],
    [2, 1, 'pending_arrival', null], [2, 2, 'pending_arrival', null],
  ]);
  assert.equal(devices[0].full_product_name, '示範筆電 13 吋 8G 256GB 粉色 DEMO-P1');
  const [summary] = await as(db, 'staffA', 'select item_count, device_total, order_status from v_order_summary where id = $1', [order_id]);
  assert.deepEqual(summary, { item_count: 2, device_total: 5, order_status: 'in_progress' });
});

test('T11 建立時不允許「已到貨／已通知／已交付」，且整筆交易回滾', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  for (const status of ['arrived_pending_notify', 'notified_pending_pickup', 'delivered', 'cancelled']) {
    const msg = await expectError(createOrder(db, 'staffA', {
      items: [
        { full_product_name: 'A', ordered_qty: 1 },
        { full_product_name: 'B', devices: [{ initial_status: 'pending_arrival' }, { initial_status: status }] },
      ],
    }));
    assert.equal(msg, 'ILLEGAL_INITIAL_STATUS', status);
  }
  for (const table of ['orders', 'order_items', 'devices']) {
    assert.equal((await asDbAdmin(db, `select count(*)::int as n from ${table}`))[0].n, 0, table);
  }
  assert.equal((await asDbAdmin(db, `select count(*)::int as n from audit_logs where action = 'create_order'`))[0].n, 0);
});

test('T11b 即使以資料庫管理者直接 insert，也不能建立非初始狀態的單機', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  const msg = await expectError(asDbAdmin(db, `
    insert into devices (order_id, order_item_id, unit_no, status, created_by)
    select order_id, order_item_id, 99, 'delivered', created_by from devices where order_id = $1`, [order_id]));
  assert.equal(msg, 'ILLEGAL_INITIAL_STATUS');
});

test('T12 已取走／不追蹤必須填原因，並記錄操作人與時間；可與待到貨混用', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const noReason = await expectError(createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', devices: [{ initial_status: 'excluded' }] }],
  }));
  assert.equal(noReason, 'REASON_REQUIRED');

  const { order_id } = await createOrder(db, 'staffA', {
    items: [{
      full_product_name: 'A',
      devices: [
        { initial_status: 'pending_arrival' },
        { initial_status: 'excluded', exclusion_reason: '顧客當場取走' },
        { initial_status: 'excluded', exclusion_reason: '顧客當場取走' },
      ],
    }],
  });
  const rows = await as(db, 'staffA', `
    select d.unit_no, d.status, d.exclusion_reason, d.excluded_at is not null as has_time, p.display_name
    from devices d left join profiles p on p.user_id = d.excluded_by
    where d.order_id = $1 order by unit_no`, [order_id]);
  assert.deepEqual(rows.map((r) => [r.unit_no, r.status, r.exclusion_reason, r.has_time, r.display_name]), [
    [1, 'pending_arrival', null, false, null],
    [2, 'excluded', '顧客當場取走', true, '王小明'],
    [3, 'excluded', '顧客當場取走', true, '王小明'],
  ]);
  const [todo] = await as(db, 'staffA', `select pending_arrival::int from v_todo_counts where store_code = 'A01'`);
  assert.equal(todo.pending_arrival, 1);
});

test('T13 同門市相同完整單據號碼拒絕建立；取消原訂單後可建立；不同門市不衝突', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const first = await createOrder(db, 'staffA', { receipt_no: 'a01-011-0196' });
  assert.equal(await expectError(createOrder(db, 'staffA2', { receipt_no: ' A01-011-0196 ' })), 'DUPLICATE_RECEIPT');

  await createOrder(db, 'staffB', { store_code: 'B02', receipt_no: 'A01-011-0196' });

  const [{ version }] = await as(db, 'staffA', 'select version from orders where id = $1', [first.order_id]);
  await as(db, 'staffA', `select cancel_order($1, $2, '輸入錯誤')`, [first.order_id, version]);
  const again = await createOrder(db, 'staffA', { receipt_no: 'A01-011-0196' });
  assert.ok(again.order_id);
});

test('T14 收銀機號＋序號＋日期相同時，需填寫確認原因才可建立', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const first = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '196' });

  const dups = await as(db, 'staffA', `select * from check_duplicate_order('A01', null, '011', '196', $1)`, [first.payload.purchase_date]);
  assert.deepEqual(dups.map((d) => [d.order_no, d.match_type]), [[first.order_no, 'register_seq_date']]);

  const msg = await expectError(createOrder(db, 'staffA', { register_no: '011', receipt_seq: '196' }));
  assert.equal(msg, 'POSSIBLE_DUPLICATE');

  const second = await createOrder(db, 'staffA', {
    register_no: '011', receipt_seq: '196', duplicate_ack_reason: '同一張單據分兩次預購，已向顧客確認',
  });
  const [row] = await as(db, 'staffA', 'select duplicate_ack_reason from orders where id = $1', [second.order_id]);
  assert.equal(row.duplicate_ack_reason, '同一張單據分兩次預購，已向顧客確認');
});

test('T15 同一個 client_request_id 送兩次只建立一張訂單', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const payload = orderPayload();
  const [r1] = await as(db, 'staffA', 'select create_order($1) as r', [payload]);
  const [r2] = await as(db, 'staffA', 'select create_order($1) as r', [payload]);
  assert.equal(r1.r.replayed, false);
  assert.equal(r2.r.replayed, true);
  assert.equal(r1.r.order_id, r2.r.order_id);
  assert.equal((await asDbAdmin(db, 'select count(*)::int as n from orders'))[0].n, 1);
  // 他人重送同一個 request id 不會取得該訂單
  assert.equal(await expectError(as(db, 'staffA2', 'select create_order($1)', [payload])), 'DUPLICATE_SUBMIT');
});

test('T16 收銀機號、序號、電話以文字保存，保留前導零', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id, order_no } = await createOrder(db, 'staffA', {
    register_no: '011', receipt_seq: '0196', customer_phone: '0912 345 678',
  });
  const [o] = await as(db, 'staffA', 'select register_no, receipt_seq, customer_phone from orders where id = $1', [order_id]);
  assert.deepEqual(o, { register_no: '011', receipt_seq: '0196', customer_phone: '0912345678' });
  assert.equal(order_no, 'A01-011-00196');
});

test('T17 必填欄位與格式驗證', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  assert.equal(await expectError(createOrder(db, 'staffA', { items: [] })), 'ITEMS_REQUIRED');
  assert.equal(await expectError(createOrder(db, 'staffA', { items: [{ full_product_name: '  ', ordered_qty: 1 }] })), 'ITEM_NAME_REQUIRED');
  assert.equal(await expectError(createOrder(db, 'staffA', { items: [{ full_product_name: 'A', ordered_qty: 0 }] })), 'INVALID_QTY');
  assert.equal(await expectError(createOrder(db, 'staffA', { customer_phone: 'abc' })), 'VALIDATION');
  assert.equal(await expectError(createOrder(db, 'staffA', { customer_name: '' })), 'VALIDATION');
  assert.equal(await expectError(createOrder(db, 'staffA', { purchase_date: '2099-01-01' })), 'VALIDATION');
  assert.equal(await expectError(createOrder(db, 'staffA', { register_no: '' })), 'VALIDATION');
});
