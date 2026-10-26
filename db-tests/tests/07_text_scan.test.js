// 掃描明細（文字）：原始文字與訂單在同一筆交易建立，掃描商品連到草稿
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as, expectError, createOrder } from '../lib/harness.js';

const RAW = '預購明細Pre-Sale\n*75000002*\n銷售日期: 2026/10/01\n機號: 011 收銀員: A00001 序號: 102';

test('T60 掃描建立：草稿已確認、連到訂單與掃描商品；手動商品不連', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const { order_id } = await createOrder(db, 'staffA', {
    scan: { raw_text: RAW, parsed: { receipt_no: '75000002' } },
    items: [
      { full_product_name: 'A', ordered_qty: 1, source: 'ocr', product_code: '1000001' },
      { full_product_name: 'B', ordered_qty: 1, source: 'manual' },
    ],
  });
  const [draft] = await as(db, 'staffA', 'select * from import_drafts where order_id = $1', [order_id]);
  assert.equal(draft.status, 'confirmed');
  assert.equal(draft.source_kind, 'text');
  assert.equal(draft.raw_text, RAW);
  assert.deepEqual(draft.parsed_fields, { receipt_no: '75000002' });
  const items = await as(db, 'staffA', 'select line_no, source, product_code, import_draft_id from order_items where order_id = $1 order by line_no', [order_id]);
  assert.deepEqual(items.map((i) => [i.source, i.import_draft_id]), [['ocr', draft.id], ['manual', null]]);
  assert.equal(items[0].product_code, '1000001');

  // 同門市其他同仁可看到原始文字；其他門市看不到
  assert.equal((await as(db, 'staffA2', 'select id from import_drafts where order_id = $1', [order_id])).length, 1);
  assert.equal((await as(db, 'staffB', 'select id from import_drafts where order_id = $1', [order_id])).length, 0);

  const [log] = await as(db, 'staffA', `select action, actor_user_id is not null as has_actor from audit_logs where entity_type = 'import_draft'`);
  assert.deepEqual(log, { action: 'create_order', has_actor: true });
});

test('T61 訂單建立失敗時不會留下草稿；ocr 商品必須附原始文字', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  assert.equal(await expectError(createOrder(db, 'staffA', {
    scan: { raw_text: RAW },
    items: [{ full_product_name: 'A', barcode: '195950823845', ordered_qty: 1, source: 'ocr' }],
  })), 'INVALID_BARCODE');
  assert.equal(await expectError(createOrder(db, 'staffA', {
    items: [{ full_product_name: 'A', ordered_qty: 1, source: 'ocr' }],
  })), 'VALIDATION');
  assert.equal(await expectError(createOrder(db, 'staffA', { scan: { raw_text: '  ' } })), 'VALIDATION');
  const [{ n }] = await as(db, 'admin', 'select count(*)::int as n from import_drafts');
  assert.equal(n, 0);
});

test('T62 前端傳入的 import_draft_id 會被忽略', async (t) => {
  const db = await freshDb(); t.after(() => db.close());
  const first = await createOrder(db, 'staffA', {
    scan: { raw_text: RAW }, items: [{ full_product_name: 'A', ordered_qty: 1, source: 'ocr' }],
  });
  const [{ import_draft_id: draftId }] = await as(db, 'staffA', 'select import_draft_id from order_items where order_id = $1', [first.order_id]);

  const second = await createOrder(db, 'staffA', {
    items: [{ full_product_name: 'B', ordered_qty: 1, import_draft_id: draftId }],
  });
  const rows = await as(db, 'staffA', 'select source, import_draft_id from order_items where order_id = $1 order by line_no', [second.order_id]);
  assert.deepEqual(rows, [{ source: 'manual', import_draft_id: null }]);
});
