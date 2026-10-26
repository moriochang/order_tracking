// 匯出紀錄：只有主管、管理者可匯出；紀錄只有 admin 看得到，且不可修改
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, asDbAdmin, expectError } from '../lib/harness.js';

test('T120 同仁不可匯出；主管匯出留下紀錄；只有 admin 看得到；紀錄不可修改', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const filters = { status: 'pending_arrival', period: '30d' };
  assert.equal(await expectError(as(db, 'staffA', `select log_export('xlsx', 3, 5, $1)`, [filters])), 'FORBIDDEN');
  assert.equal(await expectError(as(db, 'managerA', `select log_export('pdf', 3, 5)`)), 'VALIDATION');
  await as(db, 'managerA', `select log_export('xlsx', 3, 5, $1)`, [filters]);

  const sql = `select actor_display_name, after_data from audit_logs where action = 'export_orders'`;
  const [log] = await as(db, 'admin', sql);
  assert.deepEqual(log.after_data, { format: 'xlsx', orders: 3, rows: 5, filters });
  assert.equal((await as(db, 'managerA', sql)).length, 0);
  assert.equal((await as(db, 'staffA', sql)).length, 0);
  assert.equal(await expectError(asDbAdmin(db, `update audit_logs set after_data = '{}' where action = 'export_orders'`)), 'AUDIT_IMMUTABLE');
});
