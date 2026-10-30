// 每日寄送匯出 Excel（Google Apps Script，貼在同步用的 Google 試算表：擴充功能 → Apps Script）
// 每天 22:30 由 Supabase 排程呼叫（scripts/sheet-sync/daily_mail.sql），把「預購訂單」分頁存成 Excel 寄出。
// 標題與附件檔名同網頁匯出：預購訂單_YYYYMMDD（台北日期）。寄件人是這份試算表的擁有者。
// 指令碼屬性 MAIL_SECRET 要與 Supabase Vault 的 daily_mail_secret 相同。

const MAIL_TO = 'istore.tc@istore.com.tw';
const DATA_TAB = '預購訂單';
const INFO_TAB = '同步時間';

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('MAIL_SECRET');
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  if (!secret || body.secret !== secret) return ContentService.createTextOutput('UNAUTHENTICATED');
  sendDailyExport();
  return ContentService.createTextOutput('OK');
}

function sendDailyExport() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DATA_TAB);
  if (!sheet) throw new Error('找不到分頁：' + DATA_TAB);
  const name = '預購訂單_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx&gid=' + sheet.getSheetId();
  const blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } })
    .getBlob().setName(name + '.xlsx');
  const info = ss.getSheetByName(INFO_TAB);
  const syncedAt = info ? info.getRange('B1').getDisplayValue() : '';
  MailApp.sendEmail({
    to: MAIL_TO,
    subject: name,
    body: name + '\n\n附件為預購訂單匯出（全部門市、全部時間，每台單機一列，共 ' + Math.max(sheet.getLastRow() - 1, 0) + ' 列）。\n'
      + (syncedAt ? '資料同步時間：' + syncedAt + '\n' : '')
      + '\n此信由預購商品追蹤系統每天 22:30 自動寄出；檔案含顧客個資，請勿轉寄。',
    attachments: [blob],
  });
}
