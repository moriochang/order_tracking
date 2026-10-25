// 用產品資料校正辨識出的品名：以型號找出候選品名，取字元差異最少的一筆。
// 差異太大（可能型號也辨識錯）就不校正，保留原辨識結果讓同仁核對。

export type CatalogEntry = { product_name: string; model: string | null };

export function editDistance(a: string, b: string): number {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// 回傳校正後的品名；不需要或無法校正時回傳 null
export function matchCatalogName(ocrName: string, model: string, catalog: CatalogEntry[]): string | null {
  if (!ocrName || !model) return null;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const name = norm(ocrName);
  const scored = catalog
    .filter((c) => c.model === model)
    .map((c) => ({ name: norm(c.product_name), d: editDistance(name, norm(c.product_name)) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best || best.d === 0) return null;
  if (scored[1] && scored[1].d === best.d) return null;            // 兩筆一樣接近，無法判斷
  if (best.d > Math.max(2, Math.ceil([...name].length * 0.3))) return null;
  return best.name;
}
