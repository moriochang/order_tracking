// 產品資料：admin 整批匯入、同仁只能讀、型號自動取出、留下匯入紀錄
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError } from '../lib/harness.js';

const ROWS = [
  { code: '0000000001', product_name: '示範手機 17 PM 256G 橙 DEMO4', category: 'iPhone' },
  { code: '0000000002', product_name: '專 示範手機 17 PM 256G 橙 DEMO4', category: 'iPhone' },
  { code: '0000000003', product_name: '示範保護殼 透明', category: '3rd Party' },
  { code: '0000000003', product_name: '重複代碼只留一筆', category: '3rd Party' },
];

test('T70 admin 匯入產品資料；型號由品名取出；同仁可讀不可寫', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const [{ r }] = await as(db, 'admin', 'select admin_import_catalog($1) as r', [JSON.stringify(ROWS)]);
  assert.equal(r.rows, 3);
  const rows = await as(db, 'staffA', 'select code, model from product_catalog order by code');
  assert.deepEqual(rows.map((x) => x.model), ['DEMO4', 'DEMO4', null]);

  assert.equal(await expectError(as(db, 'staffA', 'select admin_import_catalog($1)', [JSON.stringify(ROWS)])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'staffA', `insert into product_catalog (code, product_name) values ('x', 'y')`)), 'permission denied for table product_catalog');
  assert.equal((await as(db, 'anon', 'select 1 from product_catalog').catch((e) => e.message)), 'permission denied for table product_catalog');

  // 再匯入一次是整批取代
  await as(db, 'admin', 'select admin_import_catalog($1)', [JSON.stringify(ROWS.slice(0, 1))]);
  assert.equal((await as(db, 'staffA', 'select code from product_catalog')).length, 1);

  const logs = await as(db, 'admin', `select action, after_data from audit_logs where entity_type = 'product_catalog' order by id`);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0].after_data, { rows: 3, categories: { iPhone: 2, '3rd Party': 1 } });
});

test('T71 匯入國際條碼：補前導 0 成 14 碼；格式不對的不存', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', 'select admin_import_catalog($1)', [JSON.stringify([
    { code: '0000000001', product_name: '示範保護殼 黑', category: '3rd Party', ean: '4895241143618' },
    { code: '0000000002', product_name: '示範保護殼 白', category: '3rd Party', ean: '12345' },
    { code: '0000000003', product_name: '示範手機 DEMO4', category: 'iPhone' },
  ])]);
  const rows = await as(db, 'staffA', 'select ean from product_catalog order by code');
  assert.deepEqual(rows.map((x) => x.ean), ['04895241143618', null, null]);
});

test('T72 型號優先取原廠型號去掉地區碼；沒有原廠型號時取品名最後一段', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', 'select admin_import_catalog($1)', [JSON.stringify([
    { code: '0000000001', product_name: '示範手機 17 PM 256G 橙 DEMO4', category: 'iPhone', manufacture_style: 'DEMO4TA/A' },
    { code: '0000000002', product_name: '示範筆電 13 128G DEMO5 專', category: 'CPU', manufacture_style: 'demo5ta/a' },
    { code: '0000000003', product_name: '示範手機 打錯 DEM06', category: 'iPhone', manufacture_style: 'DEMO6ZP/A' },
    { code: '0000000004', product_name: '示範保固 S1234', category: 'Care', manufacture_style: 'S1234Z/A' },
    { code: '0000000005', product_name: '示範保護殼 黑', category: '3rd Party', manufacture_style: '4895241143618' },
    { code: '0000000006', product_name: '示範桌機 客製 Z1U4', category: 'CPU', manufacture_style: 'Z1U4000CV' },
    { code: '0000000007', product_name: '示範手機 DEMO7', category: 'iPhone' },
  ])]);
  const rows = await as(db, 'staffA', 'select model, manufacture_style from product_catalog order by code');
  assert.deepEqual(rows.map((x) => x.model), ['DEMO4', 'DEMO5', 'DEMO6', 'S1234', null, 'Z1U4', 'DEMO7']);
  assert.equal(rows[1].manufacture_style, 'DEMO5TA/A');
});
