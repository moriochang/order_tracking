// 產品資料校正品名
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCatalogName } from '../src/lib/catalogMatch.ts';

const CATALOG = [
  { product_name: '示範手機 17 PM 256G 橙 DEMO4', model: 'DEMO4' },
  { product_name: '專 示範手機 17 PM 256G 橙 DEMO4', model: 'DEMO4' },
  { product_name: '示範筆電 13 8G 256GB 銀 DEMO5', model: 'DEMO5' },
];

test('辨識錯一個字：校正為最接近的建檔品名', () => {
  assert.equal(matchCatalogName('豆 示範手機 17 PM 256G 橙 DEMO4', 'DEMO4', CATALOG), '專 示範手機 17 PM 256G 橙 DEMO4');
  assert.equal(matchCatalogName('示範筆電 13 8G 256GB 鋃 DEMO5', 'DEMO5', CATALOG), '示範筆電 13 8G 256GB 銀 DEMO5');
});

test('完全相同、找不到型號、差異太大時不校正', () => {
  assert.equal(matchCatalogName('示範手機 17 PM 256G 橙 DEMO4', 'DEMO4', CATALOG), null);
  assert.equal(matchCatalogName('示範手機 17 PM 256G 橙 DEMO9', 'DEMO9', CATALOG), null);
  assert.equal(matchCatalogName('完全 不同 的 文字 DEMO5', 'DEMO5', CATALOG), null);
});

test('兩筆候選一樣接近時不猜', () => {
  const tie = [{ product_name: 'AB X1Y2', model: 'X1Y2' }, { product_name: 'AC X1Y2', model: 'X1Y2' }];
  assert.equal(matchCatalogName('AD X1Y2', 'X1Y2', tie), null);
});
