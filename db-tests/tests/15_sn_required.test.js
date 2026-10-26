// 主要商品（Mac、iPad、iPhone、Apple Watch、AirPods、HomePod）到貨必須登記 SN；配件可留空
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder } from '../lib/harness.js';

const CATALOG = [
  { code: '1', product_name: '示範手機 256 黑 DEMP1', category: 'iPhone' },
  { code: '2', product_name: '示範音箱 mini 白 DEMH1', category: 'Accy', sub_category: 'HomePod' },
  { code: '3', product_name: '示範保護殼 DEMC1', category: 'Accy', sub_category: 'iPhone Case' },
];

test('T140 依產品資料分類或品名判斷 SN 必填', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', 'select admin_import_catalog($1)', [JSON.stringify(CATALOG)]);
  const { order_id } = await createOrder(db, 'staffA', { items: [
    { full_product_name: '示範手機 256 黑 DEMP1', model: 'DEMP1', ordered_qty: 1 },   // iPhone
    { full_product_name: '示範音箱 mini 白 DEMH1', model: 'DEMH1', ordered_qty: 1 },  // HomePod（中分類）
    { full_product_name: '示範保護殼 DEMC1', model: 'DEMC1', ordered_qty: 1 },       // 配件
    { full_product_name: 'M9 MBA 13 銀 ZZZ99', model: 'ZZZ99', ordered_qty: 1 },     // 產品資料沒有 → 依品名（MBA）
    { full_product_name: '保貼', ordered_qty: 1 },                                     // 無型號、非主要商品
  ] });
  const devs = await as(db, 'staffA', `select d.id, d.version, i.line_no from devices d join order_items i on i.id = d.order_item_id
    where d.order_id = $1 order by i.line_no`, [order_id]);
  const req = [];
  for (const d of devs) req.push((await as(db, 'staffA', 'select device_sn_required($1) as r', [d.id]))[0].r);
  assert.deepEqual(req, [true, true, false, true, false]);

  assert.equal(await expectError(as(db, 'staffA', 'select register_arrival($1, $2, null)', [devs[0].id, devs[0].version])), 'SN_REQUIRED');
  await as(db, 'staffA', 'select register_arrival($1, $2, $3)', [devs[0].id, devs[0].version, 'CW93FPXM56']);
  await as(db, 'staffA', 'select register_arrival($1, $2, null)', [devs[2].id, devs[2].version]);
  await as(db, 'staffA', 'select register_arrival($1, $2, null)', [devs[4].id, devs[4].version]);
  // 其他門市查不到
  assert.equal((await as(db, 'staffB', 'select device_sn_required($1) as r', [devs[1].id]))[0].r, null);
});
