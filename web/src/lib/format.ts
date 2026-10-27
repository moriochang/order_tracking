const dateTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function fmtDate(isoDate: string | null | undefined): string {
  return isoDate ? isoDate.replaceAll('-', '/') : '—';
}

export function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

// 國際條碼（GTIN-8/12/13/14）檢查碼；與資料庫 app.is_valid_gtin 規則相同
// 國際條碼補前導 0 成 14 碼（與產品資料存放格式相同）；格式不對回傳 null
export function gtin14(code: string): string | null {
  const d = code.replace(/\s/g, '');
  return /^(\d{8}|\d{12,14})$/.test(d) ? d.padStart(14, '0') : null;
}

export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const d = [...code].map(Number);
  let sum = 0;
  for (let i = 1; i < d.length; i++) sum += d[d.length - 1 - i] * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === d[d.length - 1];
}
