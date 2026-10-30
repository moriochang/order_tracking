// 預購訂單_每日寄送（Google Apps Script，貼在同步用的 Google 試算表：擴充功能 → Apps Script）
// 由 Supabase 排程以網頁應用程式呼叫（POST {secret, action}）：
//   action 省略：每天 22:30 把「預購訂單」分頁存成 Excel 寄出（scripts/sheet-sync/daily_mail.sql）。
//                標題與附件檔名同網頁匯出：預購訂單_YYYYMMDD（台北日期）。寄件人是這份試算表的擁有者。
//   action = 'check_backup'：每天 09:00 檢查雲端硬碟裡有沒有當天 03:00 的資料庫備份，沒有就寄通知
//                （scripts/sheet-sync/backup_check.sql）。Mac mini 關機、休眠、備份失敗或雲端硬碟沒同步都會通知。
// 指令碼屬性 MAIL_SECRET 要與 Supabase Vault 的 daily_mail_secret 相同。

const MAIL_TO = 'istore.tc@istore.com.tw';
const DATA_TAB = '預購訂單';
const INFO_TAB = '同步時間';
const BACKUP_FOLDER = '預購商品追蹤_資料庫備份';
const BACKUP_ALERT_TO = 'morio.chang@istore.com.tw';
const BACKUP_MIN_BYTES = 100 * 1024;   // 正常約 500 KB；太小代表內容不完整

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('MAIL_SECRET');
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  if (!secret || body.secret !== secret) return ContentService.createTextOutput('UNAUTHENTICATED');
  if (body.action === 'check_backup') return ContentService.createTextOutput(JSON.stringify(checkBackup()));
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

// 檢查今天（台北日期）的資料庫備份；有問題才寄通知，回傳檢查結果
function checkBackup() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const fmt = (d) => Utilities.formatDate(d, 'Asia/Taipei', 'yyyy/MM/dd HH:mm');
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  if (!folders.hasNext()) {
    return alertBackup('找不到備份資料夾「' + BACKUP_FOLDER + '」', '這個 Google 帳號的雲端硬碟裡找不到備份資料夾，請確認資料夾名稱或擁有者。');
  }
  const folder = folders.next();
  let latest = null;
  let todayFile = null;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!/^order_tracking_\d{8}_\d{4}\.sql\.gz$/.test(f.getName())) continue;
    if (!latest || f.getName() > latest.getName()) latest = f;
    if (f.getName().indexOf('order_tracking_' + today + '_') === 0) todayFile = f;
  }
  const last = latest ? latest.getName() + '（' + Math.round(latest.getSize() / 1024) + ' KB，上傳於 ' + fmt(latest.getDateCreated()) + '）' : '沒有任何備份';
  if (!todayFile) return alertBackup('今天沒有資料庫備份', '雲端硬碟裡找不到今天 03:00 的備份。\n最近一次備份：' + last);
  if (todayFile.getSize() < BACKUP_MIN_BYTES) {
    return alertBackup('今天的資料庫備份太小', todayFile.getName() + ' 只有 ' + Math.round(todayFile.getSize() / 1024) + ' KB，內容可能不完整。');
  }
  return { ok: true, file: todayFile.getName(), kb: Math.round(todayFile.getSize() / 1024) };
}

function alertBackup(title, detail) {
  MailApp.sendEmail({
    to: BACKUP_ALERT_TO,
    subject: '【預購追蹤】備份異常：' + title,
    body: detail + '\n\n請檢查：\n'
      + '1. Mac mini 是否開機、沒有休眠，且使用者保持登入\n'
      + '2. Google 雲端硬碟電腦版是否正常同步\n'
      + '3. Mac mini 上的執行紀錄：~/order-tracking-backup/backup.log\n'
      + '4. 需要時手動備份：~/order-tracking-backup/backup.sh\n\n'
      + '此信由預購商品追蹤系統每天 09:00 自動檢查後寄出。',
  });
  return { ok: false, alert: title };
}
