// 從包裝盒標籤的辨識文字找出 SN。
// SN 一般為 10–12 碼英數字，不會有英文字母 O（一律視為數字 0）。
// 優先取「(S) Serial No.」後面的值；沒有標示時才從其他 10–12 碼英數字中找候選，交給同仁選擇。

export const normalizeSn = (s: string) => s.toUpperCase().replace(/\s/g, '').replace(/O/g, '0');
export const looksLikeSn = (s: string) => /^[A-Z0-9]{10,12}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

const RE_LABELED = /(?:\(S\)|SERIAL\s*(?:NO|NUMBER|#)?\.?|S\/N|序號)\s*[:：.]?\s*([A-Z0-9]{8,14})\b/i;
const RE_OTHER_FIELD = /PART|MODEL|UPC|EAN|IMEI|MEID|\(1P\)|\/[A-Z]/i;

export function extractSerials(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = new Set<string>();
  lines.forEach((line, i) => {
    const m = line.match(RE_LABELED);
    if (m) found.add(normalizeSn(m[1]));
    else if (/SERIAL|\(S\)/i.test(line) && lines[i + 1]) {
      // 標題與值分在兩行
      const next = lines[i + 1].match(/^([A-Z0-9]{8,14})$/i);
      if (next) found.add(normalizeSn(next[1]));
    }
  });
  if (found.size) return [...found];

  for (const line of lines) {
    if (RE_OTHER_FIELD.test(line)) continue;
    for (const token of line.split(/\s+/)) {
      const t = normalizeSn(token);
      if (looksLikeSn(t)) found.add(t);
    }
  }
  return [...found];
}
