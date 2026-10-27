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

test('iPad 單：單據欄位；數量一律 1 台，同一型號分多行時依行數合併', () => {
  const r = parseReceiptText(IPAD);
  assert.deepEqual([r.receipt_no, r.register_no, r.receipt_seq], ['75000001', '011', '101']);
  assert.deepEqual(r.items.map((i) => [i.model, i.qty, i.merged_lines]), [
    ['MH314', 3, 3], ['MH334', 3, 3], ['MH344', 3, 3],
  ]);
  assert.deepEqual(r.warnings, []);
});

test('MacBook 單：單據上的數量（7）不採用，預設 1 台；負數量的作廢行不加入並提示', () => {
  const r = parseReceiptText(MBN);
  assert.equal(r.receipt_no, '75000002');
  assert.deepEqual(r.items.map((i) => [i.model, i.qty]), [['MHFH4', 1], ['MHFA4', 1]]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /作廢/);
});

// 依實際單據（IMG_5825–5827）改寫，只要型號與數量；條碼、內部代碼、金額與消費金額以下都不取
const REAL = (date: string, reg: string, seq: string, rows: string[]) => `立展資訊科技股份有限公司
預購明細Pre-Sale
iStore台中店
- TC - iStore Tai Chung Store
地址:台中市台灣大道三段301號2樓
電話:0422586095
*75020908*
銷售日期: ${date}
機號: ${reg} 收銀員: A12163 序號: ${seq}
產品代碼/品名 數量 單價 點數/金額
${rows.join('\n')}
-------------- ---- ---------- ---------
消費金額:
(未稅) (稅額) (合計)
90,286 4,514 94,800
UCARD 94,800
卡號 ****2020
應稅科技: NT$94,800
2026/10/03 16:17:17 5802 011 00240
*07501100240*
實體店面無七天鑑賞期。
2.致電 0800-095-988 或 02-2558-0806`;

test('實際單據：只取型號，數量 1 台（國際條碼、7 碼代碼、售價都忽略）', () => {
  const iphone = parseReceiptText(REAL('2026/10/03', '011', '240', [
    'APPLE', 'iPhone 18 Pro 256 黑 MJRP4 0點', '195951419343 1 44,900 44,900TX',
    'APPLE', 'iPhone 18 Pro Max 256 黑 MJXN4 0點', '195951413709 1 49,900 49,900TX',
  ]));
  assert.deepEqual(iphone.items.map((i) => [i.model, i.qty, i.notes]), [['MJRP4', 1, []], ['MJXN4', 1, []]]);
  assert.deepEqual([iphone.register_no, iphone.receipt_seq], ['011', '240']);

  const ipad = parseReceiptText(REAL('2026/10/04', '011', '257', [
    'APPLE', 'iPad Air 11 WF 256 灰 MH354 0點', '1389583 1 28,400 28,400TX',
    'APPLE', 'Apple Pencil Pro MX2D3 0點', '1384903 1 4,390 4,390TX',
  ]));
  assert.deepEqual(ipad.items.map((i) => [i.model, i.qty]), [['MH354', 1], ['MX2D3', 1]]);

  const imac = parseReceiptText(REAL('2026/10/02', '012', '1313', [
    'APPLE', 'M4 iMac 24 10C 16 512 藍 MWV33 0點', '1386687 1 64,900 64,900TX',
    'APPLE', 'M4 iMac 24 10C 16 512 紫 Z1ET 0點', '1391648 1 64,900 64,900TX',
  ]));
  assert.deepEqual(imac.items.map((i) => [i.model, i.qty]), [['MWV33', 1], ['Z1ET', 1]]);
  assert.deepEqual(imac.warnings, []);
});

test('空白或無關文字：不捏造欄位', () => {
  const r = parseReceiptText('hello\nworld');
  assert.deepEqual([r.receipt_no, r.purchase_date, r.register_no, r.receipt_seq, r.items.length], ['', '', '', '', 0]);
  assert.ok(r.warnings.length >= 4);
});

test('「消費金額」沒辨識到時，以下的金額、底部條碼、注意事項也不會被當成商品', () => {
  const r = parseReceiptText(`預購明細Pre-Sale
*75000003*
銷售日期: 2026/10/03
機號: 011 收銀員: A00001 序號: 240
產品代碼/品名 數量 單價 點數/金額
APPLE
iPhone 18 Pro 256 黑 MJRP4 0點
195951419343 1 44,900 44,900TX
(未稅) (稅額) (合計)
42,762 2,138 44,900
2026/10/03 16:17:17 9999 011 00240
07501100240
實體店面無七天鑑賞期。
0800095988 1 2558 0806`);
  assert.deepEqual(r.items.map((i) => [i.model, i.qty]), [['MJRP4', 1]]);
  assert.deepEqual([r.receipt_no, r.register_no, r.receipt_seq], ['75000003', '011', '240']);
});
