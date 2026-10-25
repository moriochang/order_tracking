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
