// 測試環境：在 PGlite（WASM 版 PostgreSQL）中模擬 Supabase，再依序套用 supabase/migrations。
// 模擬內容：anon / authenticated / service_role 角色、auth.jwt()、Supabase 預設的寬鬆授權
// （確認 migration 有正確收回權限）。
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');

export const FIREBASE_PROJECT = 'order-tracking-test';
export const ISS = `https://securetoken.google.com/${FIREBASE_PROJECT}`;

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                    nullif(current_setting('request.jwt.claims', true), ''))::jsonb
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase 預設會把 public 的新物件授權給這些角色
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export const USERS = {
  admin:    { uid: 'fb-admin',    email: 'admin@istore.com.tw',    name: '總部管理員', role: 'admin',   stores: [] },
  staffA:   { uid: 'fb-staff-a',  email: 'staff.a@istore.com.tw',  name: '王小明',     role: 'staff',   stores: ['A01'] },
  staffA2:  { uid: 'fb-staff-a2', email: 'staff.a2@istore.com.tw', name: '陳小華',     role: 'staff',   stores: ['A01'] },
  managerA: { uid: 'fb-mgr-a',    email: 'mgr.a@istore.com.tw',    name: '林主管',     role: 'manager', stores: ['A01'] },
  staffB:   { uid: 'fb-staff-b',  email: 'staff.b@istore.com.tw',  name: '李大同',     role: 'staff',   stores: ['B02'] },
  viewerA:  { uid: 'fb-view-a',   email: 'view.a@istore.com.tw',   name: '信義檢視',   role: 'viewer',  stores: ['A01'] },
  extA:     { uid: 'fb-ext-a',    email: 'tia.part@gmail.com',     name: 'Tia',        role: 'staff',   stores: ['A01'] },
};

let basePromise;

// 套用 migration 並建立門市、帳號；之後每個測試從這個基底 clone 出獨立資料庫。
async function buildBase() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(await readFile(join(MIGRATIONS, f), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
  const a = USERS.admin;
  await db.query('select app.bootstrap_admin($1, $2, $3, $4)', [ISS, a.uid, a.email, a.name]);
  await as(db, 'admin', `select admin_upsert_store('A01', '信義門市')`);
  await as(db, 'admin', `select admin_upsert_store('B02', '板橋門市')`);
  for (const [key, u] of Object.entries(USERS)) {
    if (key === 'admin') continue;
    await as(db, 'admin', 'select admin_create_user($1, $2, $3, $4, $5)', [u.uid, u.email, u.name, u.role, u.stores]);
  }
  return db;
}

export async function freshDb() {
  basePromise ??= buildBase();
  return (await basePromise).clone();
}

// Firebase Google 登入的 ID token 會帶 email 與 email_verified
export function claimsOf(who, overrides = {}) {
  return {
    iss: ISS, aud: FIREBASE_PROJECT, sub: USERS[who].uid, role: 'authenticated',
    email: USERS[who].email, email_verified: true, ...overrides,
  };
}

// 以指定使用者身分（Firebase token 經 Supabase 驗證後的 claims）在一筆交易中執行 SQL。
// who：USERS 的 key、'anon'，或自訂 claims 物件。
export async function as(db, who, sql, params = []) {
  let claims = null;
  let role = 'authenticated';
  if (who === 'anon') {
    role = 'anon';
  } else if (typeof who === 'object') {
    claims = who;
  } else {
    claims = claimsOf(who);
  }
  return db.transaction(async (tx) => {
    if (claims) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role ${role}`);
    const res = await tx.query(sql, params);
    return res.rows;
  });
}

// 以資料庫管理者（postgres）身分直接執行，模擬「繞過 API 直接改資料庫」。
export async function asDbAdmin(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

// 期待失敗，並回傳錯誤代碼（message）
export async function expectError(promise) {
  try {
    await promise;
  } catch (e) {
    return e.message;
  }
  throw new Error('expected an error but the call succeeded');
}

export function orderPayload(overrides = {}) {
  return {
    client_request_id: randomUUID(),
    store_code: 'A01',
    customer_name: '張顧客',
    customer_phone: '0912-345-678',
    purchase_date: '2026-10-20',
    register_no: '011',
    receipt_seq: String(Math.floor(Math.random() * 1e6)).padStart(3, '0'),
    receipt_no: null,
    order_note: null,
    items: [{ full_product_name: '示範筆電 13 吋 8G 256GB 銀色 DEMO-S1', model: 'DEMO-S1', color: '銀色', ordered_qty: 1 }],
    ...overrides,
  };
}

export async function createOrder(db, who, overrides = {}) {
  const payload = orderPayload(overrides);
  const [row] = await as(db, who, 'select create_order($1) as r', [payload]);
  return { ...row.r, payload };
}
