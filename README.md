# 預購商品追蹤系統

門市同仁建立預購訂單、逐台追蹤實體機器的到貨與交付，所有異動都可追溯到操作者與時間。

- 前端：React + Vite，部署在 GitHub Pages
- 登入：Firebase Authentication（只用 Google 登入，限 `@istore.com.tw`，須由管理者開通）
- 資料：Supabase（PostgreSQL＋RLS），透過 Third-Party Auth 接受 Firebase token

設計細節見 [`docs/design-phase1.md`](docs/design-phase1.md)。

## 目前進度

| 階段 | 狀態 |
|------|------|
| 1. 核心資料與權限：資料表、RLS、稽核、狀態機、手動建立訂單、訂單詳情、帳號管理 | ✅ 已完成，資料庫自動化測試通過 |
| 2. 單機作業：登記到貨／SN、通知（含批次）、已貼、交付、單機備註、更正 SN、管理者更正狀態 | ✅ 已完成 |
| 3. 查詢與工作台：完整搜尋、狀態篩選、待辦清單、電話遮罩 | ⏳ 未實作 |
| 4. 掃描明細：iPhone「掃描文字」＋瀏覽器規則解析、相機讀條碼、交叉核對 | ✅ 已完成（不上傳圖片） |
| 5. 測試與上線 | ⏳ 未開始 |

## 專案結構

```
supabase/migrations/   資料庫 schema、RLS、稽核、狀態機、RPC（依檔名順序套用）
supabase/functions/    Edge Function admin-users（開通帳號）
db-tests/              資料庫自動化測試（PGlite，不需 Docker）
web/                   前端
scripts/               一次性工具（建立第一位 admin）
```

## 測試

```bash
cd db-tests && npm install && npm test   # 資料庫
cd web && npm test                       # 單據文字解析
```

測試會在本機的 PGlite（WASM 版 PostgreSQL）中模擬 Supabase 的角色與 Firebase token，再套用 `supabase/migrations`。
推送到 GitHub 時，GitHub Actions 也會自動執行這些測試，通過後才部署。

## 部署步驟

> ⚠ 絕不可 commit：Firebase 服務帳戶金鑰（JSON）、資料庫密碼、Supabase service_role key。

### 1. Firebase（登入）

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立專案（免費的 Spark 方案即可）。
2. **Authentication → Sign-in method**：只啟用「Google」；**Settings → User actions** 關閉自行註冊與刪除。
3. **Authentication → Settings → Authorized domains**：加入 `moriochang.github.io`。
4. **專案設定 → 一般 → 你的應用程式**：新增「網頁」應用程式，記下 `apiKey`、`authDomain`、`projectId`。
5. **專案設定 → 服務帳戶 → 產生新的私密金鑰**：下載 JSON 檔，**存放在 repo 資料夾以外的地方**。

### 2. Supabase（資料）

1. 到 [Supabase](https://supabase.com/dashboard) 建立專案，記下 **Project URL** 與 **anon（public）key**。
2. **Authentication → Sign In / Providers → Third-Party Auth**：新增 Firebase，填入 Firebase 專案 ID。
3. **SQL Editor**：依序貼上並執行 `supabase/migrations/` 內的所有檔案（照檔名順序）。

### 3. Edge Function（開通帳號用）

在 Supabase Dashboard → **Edge Functions → Deploy a new function**：

1. 函式名稱填 `admin-users`，貼上 `supabase/functions/admin-users/index.ts` 的內容後部署。
2. 函式設定中**關閉「Verify JWT」**（token 由函式內部透過資料庫驗證）。
3. **Edge Functions → Secrets** 新增：
   - `FIREBASE_SERVICE_ACCOUNT`：服務帳戶 JSON 檔的完整內容
   - `ALLOWED_ORIGINS`：`https://moriochang.github.io`（本機開發時可再加上 `,http://localhost:5173`）

### 4. 建立第一位 admin

1. 在本機執行（金鑰只在本機讀取；帳號不存在時會自動建立）：
   ```bash
   node scripts/bootstrap-admin.mjs /path/to/service-account.json 你的公司email
   ```
2. 把印出的 `select app.bootstrap_admin(...)` 貼到 Supabase SQL Editor 執行。

### 5. GitHub Pages

1. repo **Settings → Pages → Source** 選 **GitHub Actions**。
2. **Settings → Secrets and variables → Actions → Variables** 新增 5 個變數（都是公開值；publishable key 填在 `VITE_SUPABASE_ANON_KEY`）：
   `VITE_FIREBASE_API_KEY`、`VITE_FIREBASE_AUTH_DOMAIN`、`VITE_FIREBASE_PROJECT_ID`、`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`
3. 推送到 `main`，Actions 會先跑資料庫測試，通過後部署到 `https://moriochang.github.io/order_tracking/`。

### 6. 開始使用

用 admin 帳號以 Google 登入 → **設定**：新增門市 → 用公司 Email 開通同仁帳號，同仁之後直接用 Google 登入。

## 本機開發

```bash
cd web
cp .env.example .env.local   # 填入上面的公開設定值
npm install
npm run dev
```
