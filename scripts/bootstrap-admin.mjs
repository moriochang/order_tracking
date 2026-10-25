#!/usr/bin/env node
// 建立第一位 admin（只需執行一次）
//
// 用法：node scripts/bootstrap-admin.mjs <服務帳戶金鑰.json> <公司email>
// 顯示名稱自動使用 Email @ 前段。
//
// 這支程式會在 Firebase 建立（或沿用）該 Email 的帳號、設定 role: authenticated claim，
// 並印出要貼到 Supabase SQL Editor 執行的 SQL。之後用同一個 Email 的公司 Google 帳號登入。
// 金鑰檔只在本機讀取，不會上傳或寫入任何檔案。
import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

const [saPath, email] = process.argv.slice(2);
if (!saPath || !email) {
  console.error('用法：node scripts/bootstrap-admin.mjs <服務帳戶金鑰.json> <公司email>');
  process.exit(1);
}

const sa = JSON.parse(await readFile(saPath, 'utf8'));
const b64url = (s) => Buffer.from(s).toString('base64url');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 600,
  }))}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google 授權失敗：${await res.text()}`);
  return (await res.json()).access_token;
}

async function firebase(token, path, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Firebase 錯誤：${json?.error?.message}`);
  return json;
}

const token = await accessToken();
const lookup = await firebase(token, 'accounts:lookup', { email: [email.toLowerCase()] });
// 已關閉自行註冊，所以先替 admin 建立帳號；之後用同一個 Email 的公司 Google 帳號登入
const user = lookup.users?.[0]
  ?? await firebase(token, 'accounts', { email: email.toLowerCase(), displayName: email.toLowerCase().split('@')[0], emailVerified: true });
await firebase(token, 'accounts:update', {
  localId: user.localId,
  emailVerified: true,
  customAttributes: JSON.stringify({ role: 'authenticated' }),
});

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
console.log(`已為 ${email}（UID ${user.localId}）設定 role: authenticated。\n`);
console.log('請到 Supabase Dashboard → SQL Editor 執行：\n');
console.log(`select app.bootstrap_admin(${q(`https://securetoken.google.com/${sa.project_id}`)}, ${q(user.localId)}, ${q(email.toLowerCase())});`);
