// 包裝盒標籤辨識 SN
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSerials, normalizeSn } from '../src/lib/serial.ts';

test('取「(S) Serial No.」後面的值（新式 10 碼、舊式 12 碼）', () => {
  assert.deepEqual(extractSerials(`UN3481
UPC
1 95949 59481 6
(1P) Part No. MWUU3TA/A
(S) Serial No. CW93FPXM56
Model No. A3137
Assembled in China`), ['CW93FPXM56']);
  assert.deepEqual(extractSerials(`Z0QX0007L
(1P) Part No. Z0QX0007L LL
(S) Serial No. C02NQCC6FY17
Model No: A1419`), ['C02NQCC6FY17']);
});

test('標題與值分兩行；英文 O 改為 0', () => {
  assert.deepEqual(extractSerials('(S) Serial No.\nCO2NQCC6FY17\nModel No. A1419'), ['C02NQCC6FY17']);
  assert.equal(normalizeSn(' cw93 fpxm56 '), 'CW93FPXM56');
  assert.equal(normalizeSn('KV79DIOZ2A'), 'KV79D10Z2A');   // Z 與 2 都保留
});

test('照片裡有兩張標籤（另一張被切掉一半）；常見辨識誤差', () => {
  assert.deepEqual(extractSerials(`1 95950 69861 9 UPC 1 95950
(1P) Part No. MDVQ4TA/A (1P) Part No. MDH
(S) Serial No. KV79D
Model No. A3449
(S) Serial No. GFM2JJNL2F
Model No. A3448`), ['GFM2JJNL2F']);
  assert.deepEqual(extractSerials('(5) Seria1 No. GFM2JJNL2F'), ['GFM2JJNL2F']);
});

test('沒有「Serial No.」標示時不猜', () => {
  assert.deepEqual(extractSerials('Part No. MWUU3TA/A\nCW93FPXM56\nModel No. A3137\n195949594816'), []);
  assert.deepEqual(extractSerials('Assembled in China'), []);
});
