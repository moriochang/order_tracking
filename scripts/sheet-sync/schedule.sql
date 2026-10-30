-- 每 10 分鐘（每小時的 05、15…55 分）呼叫 Edge Function sync-sheet，把訂單同步到 Google 試算表；
-- 每天 22:00（台北時間，排程用 UTC 14:00）核對資料庫與試算表，結果記在「每日核對」分頁，再重新同步。
-- 兩個排程錯開分鐘，不會同時寫入。請在 Supabase SQL Editor 執行一次。
-- 執行前把 <SYNC_SECRET> 換成與 Edge Function secret SYNC_SECRET 相同的值；這個值不要存進 repo。
-- 停止同步：select cron.unschedule('sync-sheet'); select cron.unschedule('sync-sheet-verify');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 密語存在 Vault（加密保存），排程執行時才讀出
select vault.create_secret('<SYNC_SECRET>', 'sheet_sync_secret', '同步試算表 Edge Function 的呼叫密語');

select cron.schedule('sync-sheet', '5-55/10 * * * *', $$
  select net.http_post(
    url := 'https://meavjygfqpbyiutksifl.supabase.co/functions/v1/sync-sheet',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$$);

select cron.schedule('sync-sheet-verify', '0 14 * * *', $$
  select net.http_post(
    url := 'https://meavjygfqpbyiutksifl.supabase.co/functions/v1/sync-sheet',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_sync_secret')),
    body := '{"mode":"verify"}'::jsonb,
    timeout_milliseconds := 60000)
$$);
