// SQL 語法檢查（決策 2026-10-30）：用 PostgreSQL 的解析器逐檔解析 migration 與 scripts 下的 SQL 範本，
// 連 cron.schedule 的 $$ 排程本文與 language sql 函式本文也解析。範本是交給使用者貼到 SQL Editor 的，
// 其他測試不會執行到（daily-mail 排程曾因多一個右括號在 22:30 執行失敗）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, parse } from 'libpg-query';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sqlFiles = (dir) => readdirSync(join(ROOT, dir), { recursive: true })
  .filter((f) => f.endsWith('.sql')).map((f) => join(dir, f));

const walk = (o, f) => {
  if (o && typeof o === 'object') { f(o); for (const v of Object.values(o)) walk(v, f); }
};

// 字串常數裡其實是 SQL 的部分：cron.schedule 的最後一個參數、language sql 的函式本文
function innerBodies(tree) {
  const out = [];
  walk(tree, (o) => {
    if (o.FuncCall && o.FuncCall.funcname.at(-1)?.String?.sval === 'schedule') {
      const s = o.FuncCall.args?.at(-1)?.A_Const?.sval?.sval;
      if (s) out.push(['cron.schedule', s]);
    }
    if (o.CreateFunctionStmt) {
      const opt = (name) => o.CreateFunctionStmt.options?.find((x) => x.DefElem?.defname === name)?.DefElem.arg;
      const body = opt('as')?.List?.items[0]?.String?.sval;
      if (opt('language')?.String?.sval === 'sql' && body) out.push(['language sql', body]);
    }
  });
  return out;
}

test('T170 所有 SQL 檔（含排程與函式本文）語法正確', async () => {
  await loadModule();
  const files = [...sqlFiles('supabase/migrations'), ...sqlFiles('scripts')];
  assert.ok(files.some((f) => f.endsWith('daily_mail.sql')));
  const errors = [];
  for (const file of files) {
    let tree;
    try { tree = await parse(readFileSync(join(ROOT, file), 'utf8')); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
    for (const [kind, body] of innerBodies(tree)) {
      try { await parse(body); } catch (e) { errors.push(`${file} [${kind}]: ${e.message}`); }
    }
  }
  assert.deepEqual(errors, []);
});

test('T171 語法檢查抓得到排程本文裡多一個右括號', async () => {
  await loadModule();
  const tree = await parse("select cron.schedule('x', '* * * * *', $$ select jsonb_build_object('a', 1)) $$);");
  const [[, body]] = innerBodies(tree);
  await assert.rejects(parse(body), /syntax error/);
});
