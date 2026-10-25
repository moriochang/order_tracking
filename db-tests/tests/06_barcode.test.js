// 國際條碼（GTIN）：選填、檢查碼驗證、可修改並留下稽核
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

test('T50 GTIN 檢查碼驗證（UPC-A / EAN-13 / EAN-8）', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const valid = async (code) => (await asDbAdmin(db, 'select app.is_valid_gtin($1) as ok', [code]))[0].ok;
  assert.equal(await valid('195950823844'), true);   // 單據上的 UPC
  assert.equal(await valid('195950824070'), true);
  assert.equal(await valid('195950824308'), true);
  assert.equal(await valid('4006381333931'), true);  // EAN-13
  assert.equal(await valid('96385074'), true);       // EAN-8
  assert.equal(await valid('195950823845'), false);  // 檢查碼錯
  assert.equal(await valid('195950832844'), false);  // 相鄰兩碼對調（差 5 的對調是 GTIN 已知抓不到的情況）
  assert.equal(await valid('1000001'), false);       // 7 碼內部代碼不是 GTIN
  assert.equal(await valid('19595O823844'), false);  // 含字母
});

test('T51 國際條碼選填；填寫時需通過檢查碼', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    items: [
      { full_product_name: 'A', barcode: ' 195950823844 ', ordered_qty: 1 },
      { full_product_name: 'B', ordered_qty: 1 },
    ],
  });
  const rows = await as(db, 'staffA', 'select line_no, barcode from order_items where order_id = $1 order by line_no', [order_id]);
  assert.deepEqual(rows, [{ line_no: 1, barcode: '195950823844' }, { line_no: 2, barcode: null }]);

  assert.equal(await expectError(createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', barcode: '195950823845', ordered_qty: 1 }],
  })), 'INVALID_BARCODE');
});

test('T52 修改國際條碼留下前後值', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA');
  const [item] = await as(db, 'staffA', 'select id, version from order_items where order_id = $1', [order_id]);
  assert.equal(await expectError(as(db, 'staffA', `select update_order_item($1, $2, '{"barcode": "123"}')`, [item.id, item.version])), 'INVALID_BARCODE');
  await as(db, 'staffA', `select update_order_item($1, $2, '{"barcode": "195950824070"}', '補登條碼')`, [item.id, item.version]);
  const [log] = await as(db, 'staffA',
    `select before_data, after_data, reason from audit_logs where order_item_id = $1 and operation = 'UPDATE'`, [item.id]);
  assert.deepEqual(log, { before_data: { barcode: null }, after_data: { barcode: '195950824070' }, reason: '補登條碼' });
});
