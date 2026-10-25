// 預購明細文字解析：輸入 iPhone「掃描文字」／原況文字取得的單據文字，依 POS 單據格式拆成欄位。
// 只用單據上實際印出的數字做交叉核對（數量 × 單價 = 金額、合計、底部機號序號），不估算信心分數。
// 解析結果只是草稿，必須由同仁核對後才會建立訂單。
import { isValidGtin } from './format.ts';

export type ParsedItem = {
  full_product_name: string;
  model: string;
  barcode: string;        // 12–14 碼（像國際條碼）才放這裡；檢查碼錯的也放，讓表單提示核對
  product_code: string;   // 其他代碼（例如 7 碼內部代碼），不顯示
  qty: number | null;
  unit_price: number | null;
  amount: number | null;
  merged_lines: number;
  notes: string[];        // 需核對的原因
};

export type ParsedReceipt = {
  store_code: string;
  receipt_no: string;
  purchase_date: string;  // YYYY-MM-DD
  register_no: string;
  receipt_seq: string;
  items: ParsedItem[];
  checks: { label: string; ok: boolean }[];
  warnings: string[];
};

const num = (s: string) => Number(s.replace(/,/g, ''));
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

function parseNumbers(rest: string) {
  return (rest.match(/-?[\d,]*\d/g) ?? []).map(num);
}

export function parseReceiptText(text: string): ParsedReceipt {
  const lines = normalize(text);
  const out: ParsedReceipt = {
    store_code: '', receipt_no: '', purchase_date: '', register_no: '', receipt_seq: '',
    items: [], checks: [], warnings: [],
  };

  // ── 單據資料 ──
  const dateIdx = lines.findIndex((l) => /銷售日期/.test(l));
  for (const l of lines) {
    const m = l.match(/(?:^|\s)-\s*([A-Z]{2,5})\s*-\s*iStore/i) ?? l.match(/^-\s*([A-Z]{2,5})\s*-/);
    if (m) { out.store_code = m[1].toUpperCase(); break; }
  }
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

  // 底部：2026/10/01 19:57:38 9999 011 00102
  const foot = joined.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+\d{1,2}:\d{2}:\d{2}\s+\S+\s+([0-9A-Za-z]+)\s+(\d+)/);
  if (foot) {
    if (!out.purchase_date) out.purchase_date = toDate(foot[1], foot[2], foot[3]);
    if (!out.register_no) out.register_no = foot[4];
    if (!out.receipt_seq) out.receipt_seq = String(Number(foot[5]));
    out.checks.push({
      label: '單據上方與底部的日期、機號、序號一致',
      ok: out.purchase_date === toDate(foot[1], foot[2], foot[3])
        && out.register_no === foot[4]
        && Number(out.receipt_seq) === Number(foot[5]),
    });
  }

  for (const [key, label] of [['receipt_no', '預結號碼'], ['purchase_date', '銷售日期'], ['register_no', '機號'], ['receipt_seq', '序號']] as const) {
    if (!out[key]) out.warnings.push(`找不到「${label}」，請手動填寫`);
  }

  // ── 商品明細：表頭到「消費金額」之間 ──
  const start = lines.findIndex((l) => /品名/.test(l));
  let end = lines.findIndex((l, i) => i > start && /消費金額|未稅|合計/.test(l));
  if (end < 0) end = lines.length;
  const region = lines.slice(start + 1, end);

  const raw: ParsedItem[] = [];
  region.forEach((line, i) => {
    const m = line.match(RE_CODE_LINE);
    if (!m) return;
    // 品名：代碼行之前最近的一行（跳過分隔線與品牌行）
    let name = '';
    for (let j = i - 1; j >= 0; j--) {
      const prev = region[j];
      if (RE_DIVIDER.test(prev) || RE_CODE_LINE.test(prev)) break;
      if (RE_BRAND.test(prev) && !/\d/.test(prev)) continue;
      name = prev.replace(/\s*-?\d+\s*點\s*$/, '').trim();
      break;
    }
    const nums = parseNumbers((m[2] ?? '').replace(/TX$/i, ''));
    const notes: string[] = [];
    let qty: number | null = null, price: number | null = null, amount: number | null = null;
    if (nums.length >= 3) [qty, price, amount] = nums.slice(-3);
    else if (nums.length >= 1) { qty = nums[0]; notes.push('單價或金額未辨識'); }
    else notes.push('數量未辨識');
    if (qty !== null && price !== null && amount !== null && qty * price !== amount) {
      notes.push(`數量 × 單價（${qty} × ${price.toLocaleString()}）與金額 ${amount.toLocaleString()} 不符`);
    }
    if (!name) notes.push('品名未辨識');

    const code = m[1];
    const looksGtin = code.length >= 12;
    if (looksGtin && !isValidGtin(code)) notes.push('國際條碼檢查碼不正確，可能辨識錯誤');
    const tokens = name.split(' ');
    const last = tokens[tokens.length - 1] ?? '';
    raw.push({
      full_product_name: name,
      model: /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4,8}$/.test(last) ? last : '',
      barcode: looksGtin ? code : '',
      product_code: looksGtin ? '' : code,
      qty, unit_price: price, amount, merged_lines: 1, notes,
    });
  });

  // 負數量（作廢行或背面透字）不加入，只提示
  for (const it of raw.filter((r) => (r.qty ?? 0) < 0)) {
    out.warnings.push(`有一行數量為 ${it.qty}（${it.full_product_name || it.barcode || it.product_code}），可能是作廢或背面透字，未加入`);
  }

  // 同一商品重複列印時合併
  for (const it of raw.filter((r) => (r.qty ?? 0) >= 0)) {
    const same = out.items.find((x) => x.full_product_name === it.full_product_name
      && x.barcode === it.barcode && x.product_code === it.product_code && x.unit_price === it.unit_price);
    if (same && same.qty !== null && it.qty !== null) {
      same.qty += it.qty;
      same.amount = same.amount !== null && it.amount !== null ? same.amount + it.amount : null;
      same.merged_lines += 1;
      same.notes.push(...it.notes.filter((n) => !same.notes.includes(n)));
    } else {
      out.items.push({ ...it, notes: [...it.notes] });
    }
  }
  if (!out.items.length) out.warnings.push('沒有辨識到商品，請確認掃描範圍包含「產品代碼/品名」到「消費金額」');

  // 合計核對：應稅金額 NT$320,600
  const total = joined.match(/NT\$\s*([\d,]+)/);
  if (total && out.items.length) {
    const sum = out.items.reduce((s, x) => s + (x.amount ?? NaN), 0);
    out.checks.push({ label: `商品金額加總 = 單據合計 NT$${total[1]}`, ok: sum === num(total[1]) });
  }
  return out;
}
