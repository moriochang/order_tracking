// 預購明細文字解析（node --test，依實際單據格式改寫的範例，號碼皆為虛構）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText } from '../src/lib/receiptParser.ts';

const IPAD = `立展資訊科技股份有限公司
預購明細Pre-Sale
iStore台中店
- TC - iStore Tai Chung Store
*75000001*
銷售日期: 2026/09/24
機號: 011 收銀員: A00001 序號: 101
產品代碼/品名 數量 單價 點數/金額
------------- ---- --------- ---------
${[['藍', 'MH314', '195950823844'], ['星光', 'MH334', '195950824070'], ['紫', 'MH344', '195950824308']]
  .flatMap(([c, m, code]) => Array(3).fill(`APPLE\niPad Air 11 WF 128 ${c} ${m} 0點\n${code} 1 24,900 24,900TX`)).join('\n')}
------------- ---- --------- ---------
消費金額:
(未稅) (稅額) (合計)
213,429 10,671 224,100
UCARD 224,100
應稅科技: NT$224,100
==========================================
2026/09/24 17:28:52 9999 011 00101
*07501100101*`;

const MBN = `立展資訊科技股份有限公司
預購明細Pre-Sale
iStore台中店
- TC - iStore Tai Chung Store
* 7 5 0 0 0 0 0 2 *
銷售日期: 2026/10/01
機號: 011 收銀員: A00001 序號: 102
產品代碼/品名 數量 單價 點數/金額
APPLE
MBN 13 8G 256GB 胭粉 MHFH4 0點
1000001 7 22,900 160,300TX
1000003 -6 22,900 -137,400TX
APPLE
MBN 13 8G 256GB 銀 MHFA4 0點
1000002 7 22,900 160,300TX
消費金額:
應稅科技: NT$320,600
2026/10/01 19:57:38 9999 011 00102
*07501100102*`;

test('iPad 單：單據欄位、重複列印合併、條碼', () => {
  const r = parseReceiptText(IPAD);
  assert.deepEqual(
    [r.receipt_no, r.purchase_date, r.register_no, r.receipt_seq],
    ['75000001', '2026-09-24', '011', '101'],
  );
  assert.deepEqual(r.items.map((i) => [i.full_product_name, i.model, i.barcode, i.product_code, i.qty, i.merged_lines]), [
    ['iPad Air 11 WF 128 藍 MH314', 'MH314', '195950823844', '', 3, 3],
    ['iPad Air 11 WF 128 星光 MH334', 'MH334', '195950824070', '', 3, 3],
    ['iPad Air 11 WF 128 紫 MH344', 'MH344', '195950824308', '', 3, 3],
  ]);
  assert.ok(r.checks.length === 2 && r.checks.every((c) => c.ok));
  assert.deepEqual(r.warnings, []);
});

test('MacBook 單：7 碼內部代碼不當條碼、負數量行不加入並提示', () => {
  const r = parseReceiptText(MBN);
  assert.equal(r.receipt_no, '75000002');
  assert.equal(r.receipt_seq, '102');
  assert.deepEqual(r.items.map((i) => [i.full_product_name, i.barcode, i.product_code, i.qty]), [
    ['MBN 13 8G 256GB 胭粉 MHFH4', '', '1000001', 7],
    ['MBN 13 8G 256GB 銀 MHFA4', '', '1000002', 7],
  ]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /-6/);
  assert.ok(r.checks.every((c) => c.ok));
});

test('辨識錯字會被交叉核對攔下', () => {
  const r = parseReceiptText(IPAD
    .replace('195950824070 1 24,900', '195950824071 1 24,900')   // 條碼錯一碼
    .replace('2026/09/24 17:28:52 9999 011 00101', '2026/09/24 17:28:52 9999 011 00158'));
  assert.ok(r.items.some((i) => i.notes.some((n) => /檢查碼/.test(n))));
  assert.equal(r.checks.find((c) => /底部/.test(c.label))?.ok, false);

  const r2 = parseReceiptText(MBN.replace('1000002 7 22,900', '1000002 1 22,900'));   // 數量 7 認成 1
  assert.ok(r2.items[1].notes.some((n) => /不符/.test(n)));
  const r3 = parseReceiptText(MBN.replace('1000002 7 22,900 160,300', '1000002 7 22,900 160,800'));   // 金額認錯
  assert.equal(r3.checks.find((c) => /合計/.test(c.label))?.ok, false);
});

test('千分位被拆開時仍能正確對應數量、單價、金額', () => {
  const r = parseReceiptText(MBN
    .replace('1000001 7 22,900 160,300TX', '1000001 7 22, 900 160 ,300TX')
    .replace('1000002 7 22,900 160,300TX', '1000002 7 22,900 160, 300 TX'));
  assert.deepEqual(r.items.map((i) => [i.qty, i.unit_price, i.amount, i.notes]), [
    [7, 22900, 160300, []], [7, 22900, 160300, []],
  ]);
});

test('空白或無關文字：不捏造欄位', () => {
  const r = parseReceiptText('hello\nworld');
  assert.deepEqual([r.receipt_no, r.purchase_date, r.register_no, r.receipt_seq, r.items.length], ['', '', '', '', 0]);
  assert.ok(r.warnings.length >= 5);
});
