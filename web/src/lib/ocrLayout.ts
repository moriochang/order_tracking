// 把 OCR 回傳的字詞（含四角座標）依位置重組成一行一行的文字，還原單據的列印版面，
// 讓 receiptParser 能以「同一行」來對應代碼、數量、單價、金額。
// 照片歪斜時，先用字詞方向的中位數把座標轉正再分行。

export type OcrWord = { t: string; v: number[][] };  // v：左上、右上、右下、左下（依文字方向）

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export function linesFromWords(words: OcrWord[]): string {
  if (!words.length) return '';
  const angle = median(words.map(({ v }) => Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0])));
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const rot = ([x, y]: number[]) => [x * cos - y * sin, x * sin + y * cos];

  const boxes = words.map(({ t, v }) => {
    const p = v.map(rot);
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    return { t, left: Math.min(...xs), right: Math.max(...xs), cy: (top + bottom) / 2, h: bottom - top };
  });
  const h = median(boxes.map((b) => b.h)) || 1;

  // 依垂直中心分行：與目前這行的平均高度相差不到半個字高就算同一行
  const rows: { cy: number; items: typeof boxes }[] = [];
  for (const b of [...boxes].sort((a, z) => a.cy - z.cy)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(b.cy - row.cy) < h * 0.5) {
      row.items.push(b);
      row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length;
    } else {
      rows.push({ cy: b.cy, items: [b] });
    }
  }

  // 同一行由左到右；字距超過約三分之一字高才補空白（中文常被拆成單字）
  return rows.map(({ items }) => {
    items.sort((a, z) => a.left - z.left);
    let line = '';
    let prevRight = -Infinity;
    for (const b of items) {
      // 逗號、句點本身很窄，旁邊的間距看起來較大，門檻放寬
      const punct = /^[,.]/.test(b.t) || /[,.]$/.test(line);
      if (line && b.left - prevRight > h * (punct ? 0.7 : 0.35)) line += ' ';
      line += b.t;
      prevRight = b.right;
    }
    return line;
  }).join('\n');
}
