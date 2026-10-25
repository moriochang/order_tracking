// 門市的預結號碼開頭：admin 設定、不可重複、同仁可讀
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError } from '../lib/harness.js';

test('T80 設定預結號碼開頭；兩家門市不能用同一個開頭；格式限數字', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await as(db, 'admin', `select admin_upsert_store('A01', '示範門市 A', true, '75')`);
  const [s] = await as(db, 'staffA', `select receipt_prefix from stores where code = 'A01'`);
  assert.equal(s.receipt_prefix, '75');

  assert.equal(await expectError(as(db, 'admin', `select admin_upsert_store('B01', '示範門市 B', true, '75')`)), 'DUPLICATE');
  assert.equal(await expectError(as(db, 'admin', `select admin_upsert_store('B01', '示範門市 B', true, '7A')`)), 'VALIDATION');
  assert.equal(await expectError(as(db, 'managerA', `select admin_upsert_store('A01', '示範門市 A', true, '76')`)), 'FORBIDDEN');

  // 不帶開頭時清除（三個參數的舊呼叫方式仍可用）
  await as(db, 'admin', `select admin_upsert_store('A01', '示範門市 A', true)`);
  assert.equal((await as(db, 'staffA', `select receipt_prefix from stores where code = 'A01'`))[0].receipt_prefix, null);
});
