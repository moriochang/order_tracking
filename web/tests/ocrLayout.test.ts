// OCR 字詞版面重組：分行、中文單字合併、歪斜照片
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesFromWords, type OcrWord } from '../src/lib/ocrLayout.ts';

// 以「格」排版產生字詞：每個 token 給起始欄位，字寬 10、字高 20
function layout(rows: [number, string][][], angleDeg = 0): OcrWord[] {
  const a = (angleDeg * Math.PI) / 180;
  const rot = (x: number, y: number) => [Math.round(x * Math.cos(a) - y * Math.sin(a)), Math.round(x * Math.sin(a) + y * Math.cos(a))];
  const words: OcrWord[] = [];
  rows.forEach((row, r) => {
    for (const [col, t] of row) {
      const x = 100 + col * 10, y = 100 + r * 30, w = [...t].length * 10;
      words.push({ t, v: [rot(x, y), rot(x + w, y), rot(x + w, y + 20), rot(x, y + 20)] });
    }
  });
  return words.reverse();  // OCR 回傳順序不一定由上而下
}

const ROWS: [number, string][][] = [
  [[0, '銷'], [1, '售'], [2, '日'], [3, '期'], [4, ':'], [6, '2026/10/01']],
  [[0, '機'], [1, '號'], [2, ':'], [4, '011'], [8, '序'], [9, '號'], [10, ':'], [12, '196']],
  [[0, 'MBN'], [4, '13'], [7, '8G'], [10, '256GB'], [16, '銀'], [18, 'MHFA4'], [30, '0'], [31, '點']],
  [[0, '1389776'], [12, '7'], [16, '22'], [18, ','], [19, '900'], [24, '160,300TX']],
];
const EXPECTED = [
  '銷售日期: 2026/10/01',
  '機號: 011 序號: 196',
  'MBN 13 8G 256GB 銀 MHFA4 0點',
  '1389776 7 22,900 160,300TX',
].join('\n');

test('同一行的字詞由左到右排好；中文單字合併、欄位之間留空白', () => {
  assert.equal(linesFromWords(layout(ROWS)), EXPECTED);
});

test('照片歪斜 4 度仍能正確分行', () => {
  assert.equal(linesFromWords(layout(ROWS, 4)), EXPECTED);
  assert.equal(linesFromWords(layout(ROWS, -4)), EXPECTED);
});

test('沒有字詞時回傳空字串', () => {
  assert.equal(linesFromWords([]), '');
});
