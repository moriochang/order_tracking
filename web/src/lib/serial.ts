// 從包裝盒標籤的辨識文字找出 SN。
// SN 一般為 10–12 碼英數字，不會有英文字母 O、I（一律視為數字 0、1）。
// SN 就是標籤上「(S) Serial No.」後面的值；只取有這個標示的，不從其他代碼猜。

export const normalizeSn = (s: string) => s.toUpperCase().replace(/\s/g, '').replace(/O/g, '0').replace(/I/g, '1');
export const looksLikeSn = (s: string) => /^[A-Z0-9]{10,12}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

// 容許常見辨識誤差：(S) 讀成 (5)、Serial 的 i／l 讀成 1
const RE_LABELED = /(?:\(\s*[S5]\s*\)|SER[I1L]A[L1I]\s*(?:N[O0]|NUMBER|#)?\.?|S\/N)\s*[:：.]?\s*([A-Z0-9]{8,14})\b/i;

export function extractSerials(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = new Set<string>();
  lines.forEach((line, i) => {
    const m = line.match(RE_LABELED);
    if (m) found.add(normalizeSn(m[1]));
    else if (/SER[I1L]A[L1I]|\(\s*[S5]\s*\)/i.test(line) && lines[i + 1]) {
      // 標題與值分在兩行
      const next = lines[i + 1].match(/^([A-Z0-9]{8,14})$/i);
      if (next) found.add(normalizeSn(next[1]));
    }
  });
  return [...found];
}
