-- 每天 09:00（台北時間，排程用 UTC 01:00）請試算表的 Apps Script 檢查當天 03:00 的資料庫備份是否已上傳到雲端硬碟；
-- 沒有或太小就寄通知給 morio.chang@istore.com.tw。沿用每日寄送的網址與密語（Vault daily_mail_url、daily_mail_secret）。
-- 請在 Supabase SQL Editor 執行一次。停止檢查：select cron.unschedule('backup-check');

select cron.schedule('backup-check', '0 1 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'daily_mail_url'),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('secret', (select decrypted_secret from vault.decrypted_secrets where name = 'daily_mail_secret'),
                               'action', 'check_backup'),
    timeout_milliseconds := 60000)
$$);
