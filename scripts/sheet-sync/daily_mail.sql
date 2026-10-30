-- 每天 22:30（台北時間，排程用 UTC 14:30）呼叫試算表的 Apps Script，寄送匯出 Excel 到 istore.tc@istore.com.tw。
-- 同時在「匯出紀錄」留下一筆（操作人：每日自動寄送）。請在 Supabase SQL Editor 執行一次。
-- 執行前把 <WEBAPP_URL> 換成 Apps Script 網頁應用程式網址、<MAIL_SECRET> 換成指令碼屬性 MAIL_SECRET 的值；兩者都不要存進 repo。
-- 停止寄送：select cron.unschedule('daily-mail');

select vault.create_secret('<WEBAPP_URL>', 'daily_mail_url', '每日寄送 Apps Script 網址');
select vault.create_secret('<MAIL_SECRET>', 'daily_mail_secret', '每日寄送 Apps Script 密語');

select cron.schedule('daily-mail', '30 14 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'daily_mail_url'),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('secret', (select decrypted_secret from vault.decrypted_secrets where name = 'daily_mail_secret')),
    timeout_milliseconds := 60000);
  insert into public.audit_logs (entity_type, entity_id, operation, action, actor_display_name, actor_db_role, after_data)
  select 'export', gen_random_uuid()::text, 'INSERT', 'export_orders', '每日自動寄送', session_user,
         jsonb_build_object('format', 'xlsx', 'orders', (select count(*) from public.orders), 'rows', coalesce(s.last_rows, 0),
                            'filters', jsonb_build_object('寄送', 'istore.tc@istore.com.tw'))
  from app.sheet_sync s;
$$);
