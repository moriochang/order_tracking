// 正式上線前清除測試資料的腳本（scripts/reset/reset_test_data.sql）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freshDb, as, asDbAdmin, expectError, createOrder } from '../lib/harness.js';

const SCRIPT = await readFile(new URL('../../scripts/reset/reset_test_data.sql', import.meta.url), 'utf8');
const withKeep = (nos) => SCRIPT.replace('array[]::text[]', `array[${nos.map((n) => `'${n}'`).join(', ')}]::text[]`);
const count = async (db, sql) => Number((await asDbAdmin(db, sql))[0].n);

async function seed(db) {
  const a = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '1' });
  const b = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '2' });
  // 拍照辨識建立的訂單：商品明細會指向掃描原文（2026-10-28 演練時發現的刪除順序問題）
  await createOrder(db, 'staffA', {
    register_no: '011', receipt_seq: '3', scan: { raw_text: '預購明細', parsed: {} },
    items: [{ full_product_name: '示範手機 DEMO4', model: 'DEMO4', ordered_qty: 1, source: 'ocr' }],
  });
  const [dev] = await as(db, 'staffA', 'select id, version from devices where order_id = $1', [a.order_id]);
  await as(db, 'staffA', 'select register_arrival($1, $2, $3)', [dev.id, dev.version, 'SN-A']);
  await as(db, 'staffA', `select record_notification($1, 'phone', 'contacted')`, [[dev.id]]);
  await as(db, 'managerA', `select log_export('csv', 2, 2)`);
  return { a, b };
}

test('T160 保留指定訂單、清除其他；帳號紀錄保留；保護恢復；留下重置紀錄', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { a, b } = await seed(db);
  const profileLogs = await count(db, `select count(*) n from audit_logs where entity_type = 'profile'`);

  await db.exec(withKeep([b.order_no]));

  assert.deepEqual((await asDbAdmin(db, 'select order_no from orders')).map((r) => r.order_no), [b.order_no]);
  assert.equal(await count(db, `select count(*) n from devices where order_id = '${a.order_id}'`), 0);
  assert.equal(await count(db, 'select count(*) n from notifications'), 0);
  assert.equal(await count(db, `select count(*) n from audit_logs where order_id = '${a.order_id}'`), 0);
  assert.ok(await count(db, `select count(*) n from audit_logs where order_id = '${b.order_id}'`) > 0);
  assert.equal(await count(db, `select count(*) n from audit_logs where entity_type = 'export'`), 0);
  assert.equal(await count(db, `select count(*) n from audit_logs where entity_type = 'profile'`), profileLogs);
  assert.ok(await count(db, 'select count(*) n from profiles') > 0);

  const [log] = await asDbAdmin(db, `select after_data from audit_logs where action = 'reset_test_data'`);
  assert.deepEqual(log.after_data, { orders: 2, devices: 2, kept_orders: 1 });
  assert.equal(await count(db, 'select count(*) n from import_drafts'), 0);

  // 保護已恢復
  assert.equal(await expectError(asDbAdmin(db, `update audit_logs set reason = 'x' where action = 'reset_test_data'`)), 'AUDIT_IMMUTABLE');
  assert.equal(await expectError(asDbAdmin(db, `delete from orders where order_no = '${b.order_no}'`)), 'DELETE_NOT_ALLOWED');
  // 清除後同機號序號可以重新建立，不會加尾碼
  const again = await createOrder(db, 'staffA', { register_no: '011', receipt_seq: '1' });
  assert.equal(again.order_no, a.order_no);
});

test('T161 保留清單寫錯編號時整個中止，不做任何變更', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  await seed(db);
  const before = await count(db, 'select count(*) n from orders');
  await assert.rejects(db.exec(withKeep(['75-999-99999'])), /找不到要保留的訂單/);
  await db.exec('rollback').catch(() => {});
  assert.equal(await count(db, 'select count(*) n from orders'), before);
});
