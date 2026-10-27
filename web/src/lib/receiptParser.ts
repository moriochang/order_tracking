// 預購明細文字解析：輸入 Vision 辨識出的單據文字，依 POS 單據格式拆成欄位。
// 只取「預購明細 Pre-Sale」到「消費金額」之間：上方的預結號碼、機號、序號，與每項商品的型號（數量預設 1 台）。
// 國際條碼／內部代碼、數量、金額、消費金額以下的資訊都不需要（決策 2026-10-27）。
// 解析結果只是草稿，必須由同仁核對後才會建立訂單。

export type ParsedItem = {
  full_product_name: string;  // 單據上的品名，帶入時會依型號換成產品資料的正式品名
  model: string;
  qty: number | null;
  merged_lines: number;
  notes: string[];        // 需核對的原因
  fixes: string[];        // 已自動校正的地方（例如依產品資料帶入品名）
};
export type ParsedReceipt = {
  receipt_no: string;
  purchase_date: string;  // YYYY-MM-DD
  register_no: string;
  receipt_seq: string;
  items: ParsedItem[];
  checks: { label: string; ok: boolean }[];
  warnings: string[];
};

const pad2 = (s: string) => s.padStart(2, '0');

function toDate(y: string, m: string, d: string) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// 全形數字、冒號、斜線等轉半形，合併多餘空白
function normalize(text: string) {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

const RE_CODE_LINE = /^(\d{7,14})(?:\s+(.*))?$/;
const RE_DIVIDER = /^[-=_ ]{4,}$/;
const RE_BRAND = /^[A-Z][A-Z&.\- ]{1,20}$/;

// 只取單據的明細區塊：「預購明細 Pre-Sale」到「消費金額」為止。
// 上方公司名稱、消費金額以下（金額、卡號、底部條碼、注意事項）都不解析。
function receiptBlock(all: string[]) {
  let from = all.findIndex((l) => /預購明細|Pre-?Sale/i.test(l));
  if (from < 0) from = 0;
  const markers = [/消費金額/, /未稅|稅額|合計|UCARD|NT\$/, /\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/, /鑑賞期|保固|AppleCare/i];
  for (const re of markers) {
    const to = all.findIndex((l, i) => i > from && re.test(l) && !/銷售日期/.test(l));
    if (to >= 0) return all.slice(from, to);
  }
  return all.slice(from);
}

export function parseReceiptText(text: string): ParsedReceipt {
  const lines = receiptBlock(normalize(text));
  const out: ParsedReceipt = {
    receipt_no: '', purchase_date: '', register_no: '', receipt_seq: '',
    items: [], checks: [], warnings: [],
  };

  // ── 單據資料 ──
  const dateIdx = lines.findIndex((l) => /銷售日期/.test(l));
  // 上方條碼下的數字（*75000002*）；底部也有一條，只取銷售日期之前的
  const barcodeLines = lines
    .map((l, i) => ({ i, m: l.match(/^\*?\s*((?:\d\s*){6,14})\*?$/) }))
    .filter((x) => x.m && (/\*/.test(lines[x.i]) || x.i < dateIdx));
  const top = barcodeLines.find((x) => dateIdx < 0 || x.i < dateIdx);
  if (top) out.receipt_no = top.m![1].replace(/\s/g, '');

  const joined = lines.join('\n');
  const d = joined.match(/銷售日期\s*[:：]?\s*(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (d) out.purchase_date = toDate(d[1], d[2], d[3]);
  const reg = joined.match(/機號\s*[:：]?\s*([0-9A-Za-z]+)/);
  if (reg) out.register_no = reg[1];
  const seq = joined.match(/序號\s*[:：]?\s*([0-9A-Za-z]+)/);
  if (seq) out.receipt_seq = seq[1];

  for (const [key, label] of [['receipt_no', '預結號碼'], ['register_no', '機號'], ['receipt_seq', '序號']] as const) {
    if (!out[key]) out.warnings.push(`找不到「${label}」，請手動填寫`);
  }

  // ── 商品明細：表頭之後到區塊結尾 ──
  const start = lines.findIndex((l) => /品名/.test(l));
  const region = lines.slice(start + 1);

  const raw: ParsedItem[] = [];
  region.forEach((line, i) => {
    const m = line.match(RE_CODE_LINE);
    if (!m) return;
    // 負數量是作廢行（或背面透字），不加入，只提示
    if (/(^|\s)-\d/.test(m[2] ?? '')) {
      out.warnings.push(`有一行數量為負（${m[1]}），可能是作廢或背面透字，未加入`);
      return;
    }
    // 品名：代碼行之前最近的一行（跳過分隔線與品牌行）
    let name = '';
    for (let j = i - 1; j >= 0; j--) {
      const prev = region[j];
      if (RE_DIVIDER.test(prev) || RE_CODE_LINE.test(prev)) break;
      if (RE_BRAND.test(prev) && !/\d/.test(prev)) continue;
      name = prev.replace(/\s*-?\d+\s*點\s*$/, '').trim();
      break;
    }
    // 數量一律預設 1 台（決策 2026-10-27），同仁依單據調整；同一型號分成多行時合併加總
    const notes: string[] = [];
    const qty = 1;
    if (!name) notes.push('品名未辨識');

    const tokens = name.split(' ');
    const last = tokens[tokens.length - 1] ?? '';
    const model = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4,8}$/.test(last) ? last : '';
    if (!model) notes.push('型號未辨識');
    raw.push({ full_product_name: name, model, qty, merged_lines: 1, notes, fixes: [] });
  });

  // 同一型號重複列印時合併
  for (const it of raw) {
    const same = out.items.find((x) => x.model === it.model && x.full_product_name === it.full_product_name);
    if (same && same.qty !== null && it.qty !== null) {
      same.qty += it.qty;
      same.merged_lines += 1;
      same.notes.push(...it.notes.filter((n) => !same.notes.includes(n)));
    } else {
      out.items.push({ ...it, notes: [...it.notes] });
    }
  }
  if (!out.items.length) out.warnings.push('沒有辨識到商品，請確認照片包含「產品代碼/品名」到「消費金額」');
  return out;
}
