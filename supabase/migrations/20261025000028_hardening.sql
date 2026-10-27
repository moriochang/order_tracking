-- 安全檢查後的修正（2026-10-27）
-- 1. 結帳／預購日期固定為建單當天（台北時間），之後不可修改：原本只在畫面上鎖定，改由資料庫強制。
-- 2. 未登入（anon）不能執行任何函式：原本呼叫後也會被函式本身拒絕，這裡再收回執行權限多一層保險。

create function app.lock_purchase_date()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.purchase_date := (now() at time zone 'Asia/Taipei')::date;
  elsif new.purchase_date is distinct from old.purchase_date then
    perform app.fail('PURCHASE_DATE_LOCKED');
  end if;
  return new;
end $$;
create trigger lock_purchase_date before insert or update of purchase_date on public.orders
  for each row execute function app.lock_purchase_date();

-- 已登入同仁原本能執行的函式明確授權給 authenticated，再收回 public、anon 的執行權限
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
  loop
    if has_function_privilege('authenticated', f, 'execute') then
      execute format('grant execute on function %s to authenticated', f);
    end if;
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
