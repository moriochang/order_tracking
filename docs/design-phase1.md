# 預購商品追蹤系統：規格審查與第一階段設計

> 需求依據：`docs/requirements.md`（原始規格副本）
> 狀態：**已確認，第一階段開發中**
> 日期：2026-10-25

## 決策紀錄（2026-10-25 確認）

| 項目 | 決定 |
|------|------|
| M3 顧客資料 | 顧客姓名、電話、編號直接存在訂單上，第一階段不建立共用的 `customers` 表 |
| P1 角色 | 分 `staff`、`manager`、`admin` 三種，透過 `user_stores` 讓一人可以屬於多間門市 |
| P3 取消 | **一般同仁（staff）也可以取消**訂單、商品、單機，原因必填。管理者更正（退回狀態、SN 更正）仍然只有 manager 以上可以做 |
| S4 SN | 到貨時 SN 必填 |
| S3 通知 | **只要有聯繫就算通知**：不論結果是否聯絡上，狀態都會轉為 `notified_pending_pickup`。每次的聯繫結果照樣保留。⚠ 這和原規格 §3.5、§6.2，以及驗收清單「通知失敗不會將狀態改成已通知」不同，這裡以本決定為準。`notification_outcomes.is_success` 仍然保留可以調整，預設全部為 true |
| P5 登入 | Firebase Auth，Email 加密碼，邀請制（§2.1） |
| 部署 | GitHub Pages，使用公開 repo `moriochang/order_tracking`。**`docs/requirements.md` 不 commit** |

---

## 1. 規格審查：矛盾與未定義處

下面每一項都附上建議的處理方式。標「需確認」的項目會影響 schema，請在開工前決定。

### 1.1 資料模型

| # | 問題 | 規格位置 | 建議處理 |
|---|------|----------|----------|
| M1 | **`ordered_qty` 和單機筆數是兩份資料，可能不一致。** 規格允許事後「數量修改」，但沒說要新增或刪除哪幾台單機。 | 3.3、3.4、§8 | 數量只能透過 `change_item_quantity()` 修改。**增加**數量時自動補建單機；**減少**數量時，必須指定要取消哪幾台（只能選「待到貨」或「已取走」的機器），被取消的機器保留紀錄。資料庫另外檢查：`ordered_qty` 必須等於該商品「未取消的單機數」。 |
| M2 | **「已取走／不追蹤」只能整筆訂單設定，但單機要獨立追蹤。** 區塊 C 看起來是整筆訂單一個設定，可是實務上可能是「訂 7 台、當場取走 2 台」。 | 4 步驟 4、§10 區塊 C | 初始狀態**以單機為單位**設定。介面提供「全部套用」，也可以逐台調整；每台 excluded 都要填原因。 |
| M3 | **顧客資料的歸屬不明。** 規格有 `customers` 表，但又把姓名、電話列為「訂單資料修改」。如果共用顧客表，在 A 訂單改電話，會連帶改到這位顧客的其他訂單，也讓跨門市的權限範圍變複雜。 | 3.1、§8 | **需確認**。建議第一階段把顧客姓名、電話、編號直接存在訂單上（依當時的預購單記錄），修改只影響該訂單並留下稽核。`customers` 表等到需要「顧客歷史」時再加入，現有資料可以依電話回填。 |
| M4 | **SN 唯一性和取消有衝突。** 已登記 SN 的機器如果被取消，同一台實機可能改配給別的訂單，這時會撞到唯一約束。 | 3.4、§11-12 | 唯一索引改為「`upper(trim(sn))`，排除空值和 `cancelled`」。被取消機器的 SN 保留在紀錄上，但不再佔用。SN 一律去除空白並轉大寫後比對。 |
| M5 | **訂單沒有狀態欄位。** 訂單的完成概況要即時算，訂單取消時，旗下單機也要一起處理。 | 3.2、§7 | 訂單狀態不另外存，由單機彙總計算（view）。`cancel_order()` 會在同一筆交易裡把所有尚未結束的單機改成 `cancelled`。只要有任何一台已交付，就拒絕取消整張訂單，改為逐台取消。 |
| M6 | **通知是以單機為單位，但實務上打一通電話就通知了整張訂單。** | 3.5、6.2 | 保留「每台單機一筆」的規則，另外新增 `batch_id`。一次通知可以勾選多台，系統會建立多筆通知紀錄，這些紀錄共用同一個 `batch_id`。 |
| M7 | **混用 OCR 與手動新增，但商品沒有記錄來源。** | 4 步驟 2 | `order_items` 新增 `source`（manual/ocr）和 `import_draft_id`。`import_drafts` 新增 `order_id`，記錄最後匯入到哪張訂單。 |
| M8 | 稽核紀錄要依門市權限查看，但規格的稽核欄位沒有門市。 | 2、3.6 | `audit_logs` 新增 `store_code`，依此套用 RLS。 |

### 1.2 狀態流程

| # | 問題 | 建議處理 |
|---|------|----------|
| S1 | **「待貼標」的範圍沒有定義（「仍需處理」是哪些狀態？）。** 貼標代表實機已留貨，所以待到貨的機器不可能貼標。 | 待貼標的定義是 `is_labeled = false` 且狀態為 `arrived_pending_notify` 或 `notified_pending_pickup`。只有這兩個狀態可以切換「已貼」；已交付、取消、排除的機器不能切換。 |
| S2 | **已經通知過、顧客還沒來取，能不能再通知一次？** 規格只寫了「待通知」狀態下可以重試。 | 允許在 `notified_pending_pickup` 再次通知（催取），新增一筆紀錄，但狀態不變；這次失敗也不會把狀態退回去。 |
| S3 | **哪些通知結果算「成功」？**「訊息已送出」不等於顧客已收到。 | **需確認**。建議用一張 `notification_outcomes` 對照表，設定 `is_success`。預設「已聯絡」和「訊息已送出」為成功，「無人接聽」和「未聯絡成功」為失敗。管理者可以調整，調整也會留下稽核。 |
| S4 | **SN 是否必填：到貨時「建議必填」，但交付時又要「確認 SN」。** 如果到貨時沒填 SN，交付時就沒有東西可以確認。 | **需確認**。建議到貨時 SN 必填（資料庫檢查：到貨後的狀態 SN 不得為空）。如果門市允許先到貨、後補 SN，就改成交付前必填。 |
| S5 | **管理者「更正／退回」可以退到哪些狀態沒有定義，退回後原本的到貨時間、交付時間要怎麼處理也沒說。** | 只允許退回一格：delivered → notified、notified → arrived、arrived → pending、excluded → pending，cancelled 可以恢復成取消前的狀態。退回時清掉該步驟的欄位（例如交付時間、交付人），舊值完整保存在稽核紀錄裡。原因必填。 |
| S6 | **excluded 誤選了怎麼辦？** 規格只說之後要排除時走取消流程。 | 管理者可以用 S5 的更正流程把 excluded 改回 pending_arrival。 |
| S7 | 規格沒有提到退貨和換貨（已交付之後）。 | 不在本次範圍內。已交付的機器只有管理者能更正，不提供取消。 |

### 1.3 權限

| # | 問題 | 建議處理 |
|---|------|----------|
| P1 | **門市範圍沒有定義：同仁屬於一間還是多間門市？主管管一間門市，還是總部管全部？** | **需確認**。建議分三種角色：`staff`（門市同仁）、`manager`（門市主管，只管自己被指派的門市）、`admin`（總部，看全部門市並管理帳號）。用 `user_stores` 表處理一人多門市。 |
| P2 | **「需要核准時記錄核准人」，但規格沒有核准流程。** 如果讓操作者自己輸入核准人姓名，這個欄位無法驗證。 | 第一階段由「執行者就是核准者」處理：只有 manager 以上可以執行高風險操作，稽核紀錄會寫下執行者。雙人核准（申請 → 核准）列為之後的擴充，先保留 `approved_by` 欄位。 |
| P3 | 取消單機或訂單，一般同仁可以做嗎？規格寫「依公司政策」。 | **需確認**。預設只有 manager 以上可以取消；一般同仁只能在建立時選擇 excluded。 |
| P4 | 電話「依權限遮罩」，但 RLS 只能控制整列資料，不能遮住單一欄位。 | 第一階段所有有權限的同仁都看得到完整電話。第三階段用 view 或函式回傳遮罩後的電話，並另外記錄「誰查看了完整電話」。 |
| P5 | 登入方式。 | **已決定（2026-10-25）**：使用 Firebase Authentication（先建在私人帳號底下），以 Email 加密碼登入，帳號由 admin 邀請建立，**不開放自行註冊**。就算有人在 Firebase 自行註冊，資料庫裡沒有對應的啟用帳號，也一樣看不到任何資料。詳見 §2.1。 |

### 1.4 稽核

| # | 問題 | 建議處理 |
|---|------|----------|
| A1 | 「不應透過直接修改資料庫繞過稽核」：如果稽核是在 API 裡寫入，直接用 SQL 改資料就不會留下紀錄。 | 稽核改由**資料表觸發器（trigger）**產生，不靠 API 自己寫入。任何寫入，包括在後台直接下 SQL，都會被記錄。如果寫入沒有經過正式流程，紀錄的動作會標為 `direct_db_change`，方便抓出繞過流程的修改。業務流程函式會在同一筆交易裡設定「動作名稱」和「原因」，交給觸發器一起寫入。 |
| A2 | 「每筆異動要記錄操作結果」：被拒絕的操作（例如 SN 重複）會整筆交易回滾，稽核紀錄也會跟著消失。 | 稽核紀錄只記「已成功提交的異動」；被拒絕的操作會回傳明確的錯誤給前端。如果公司要求連失敗的嘗試都要記錄，可以在第二階段加一個獨立寫入的 `rejected_attempts` 紀錄。**需確認**是否需要。 |
| A3 | 稽核紀錄不能被刪改。 | `audit_logs` 只開放 SELECT（依 RLS）。另外加觸發器，拒絕所有 UPDATE、DELETE、TRUNCATE，連 service role 都適用。 |
| A4 | 重複單據的判斷規則：規格同時要求「防止重複建立」和「疑似重複時讓同仁確認」。 | 分兩層處理：(1) 同門市、完整單據號碼相同，視為硬性重複，資料庫直接拒絕（已取消的訂單除外）；(2) 收銀機號、單據序號、日期相同但沒有完整單據號碼，視為疑似重複，顯示既有訂單，同仁必須勾選「確認不是重複」並填原因，這也會寫入稽核。另外每次送出都帶 `client_request_id`（唯一值），防止重複點擊造成重複建立。 |

---

## 2. 技術架構

```
瀏覽器（手機／桌機）
  React + TypeScript + Vite（SPA），部署在 GitHub Pages（由 GitHub Actions 建置）
  │  ① Firebase Auth 用 Email 加密碼登入，取得 Firebase ID token
  │  ② 用 supabase-js 的 accessToken() 把 Firebase token 交給 Supabase
  │     ├─ 讀取：直接 SELECT，受 RLS 限制
  │     └─ 寫入：只能呼叫 RPC（PostgreSQL 函式），不能直接寫入資料表
  ▼
Firebase（私人帳號）              Supabase
  └─ Authentication（只用這項）    ├─ Third-Party Auth：信任這個 Firebase 專案發出的 token
                                   ├─ Edge Function admin-users：持有 Firebase 服務帳戶，
                                   │     負責建立帳號、設定 role claim、寄送設定密碼信
                                   ├─ Postgres
  │   ├─ 資料表：authenticated 角色沒有 INSERT/UPDATE/DELETE 權限
  │   ├─ RPC：security definer，檢查角色、門市、目前狀態、必要欄位
  │   ├─ CHECK 約束與唯一索引：資料庫層的最後防線
  │   └─ 稽核觸發器：所有異動都會寫入 audit_logs
  ├─ Storage：私有 bucket 放單據照片（第四階段）
  └─ Edge Function：呼叫 OCR（第四階段，服務商待公司核准）
```

### 2.1 Firebase 登入與 Supabase 的串接（2026-10-25 決定）

1. **Supabase 端設定**：在 Authentication 的 Third-Party Auth 加入 Firebase，填入 Firebase 專案 ID。Supabase 只接受這個專案發出的 token。
2. **role claim**：Supabase 必須在 token 裡看到 `role: "authenticated"` 才會把使用者當成已登入，否則只當成 `anon`，什麼都讀不到。Firebase 預設不會放這個 claim，需要另外設定。我們不使用 Firebase Cloud Functions（需要付費的 Blaze 方案），改由 Supabase Edge Function `admin-users` 在 admin 建立帳號時，透過 Firebase Admin REST API 設定。
   - 建立帳號的流程：admin 在設定頁輸入 Email、姓名、角色、門市，Edge Function 會先驗證呼叫者確實是 admin，接著建立 Firebase 帳號並設定 claim、寫入 `profiles`，最後寄出設定密碼的信。以上每一步都會留下稽核紀錄。
   - 第一個 admin 帳號用一次性的本機指令建立。
3. **使用者身分不直接用 Firebase UID**：Firebase UID 不是 UUID，所以不能用 `auth.uid()`，一律改用 `auth.jwt()->>'sub'`。`profiles` 有自己的內部 `id`（uuid），所有 `created_by`、`actor_user_id` 都指向這個內部 ID；Firebase UID 只存在 `profiles.auth_uid` 這一欄。**這樣將來把 Firebase 從私人帳號搬到公司帳號時，只要重新對應這一欄，歷史稽核紀錄完全不受影響。**
4. **白名單**：`app.current_profile()` 會用 token 的 `sub` 和 `iss` 查詢 `profiles`，而且帳號必須是啟用中（`is_active`）。查不到就沒有任何權限，所以就算有人在 Firebase 自行註冊也沒用。
5. **縱深防禦**：每張表都加上一條 restrictive policy，檢查 `iss = https://securetoken.google.com/<project-id>`，並且 `aud = <project-id>`。
6. **私人帳號的風險控管**：
   - 至少再加一位公司同仁成為 Firebase 專案的 Owner，避免帳號只綁在一個人身上。
   - Firebase 只存登入帳號（Email 和密碼雜湊），**顧客與訂單資料完全不在 Firebase**。
   - 之後要搬到公司帳號時，用 `firebase auth:export` 和 `auth:import` 搬移，UID 和密碼雜湊都可以保留；接著更新 Supabase Third-Party Auth 的專案 ID，以及 `profiles.auth_iss`。

### 2.2 GitHub Pages 注意事項

- 前端是純靜態網站，所有規則都在資料庫裡，所以適合放在 GitHub Pages。
- **私有 repo 要使用 Pages，需要 GitHub 付費方案（Pro/Team）**；如果用免費方案的公開 repo，原始碼會被公開。程式碼裡沒有任何機密：Firebase 設定和 Supabase anon key 本來就是公開值，安全性靠 RLS 和 RPC 保證。但公開 repo 會讓別人看到商業邏輯和資料結構。**需確認**用哪一種。
- 路由使用 HashRouter（網址會像 `/#/orders/123`），避免 GitHub Pages 在重新整理頁面時出現 404。
- 需要在 Firebase Authentication 的 Authorized domains 加入 `<帳號>.github.io`。

**為什麼「狀態不能被前端跳過」可以保證：**
1. 前端沒有資料表的寫入權限，就算有人改了前端程式碼，直接 UPDATE devices 也會被拒絕。
2. 唯一的寫入入口是 RPC。每個 RPC 都會用 `SELECT ... FOR UPDATE` 鎖住要改的資料，再檢查目前狀態是否符合，例如 `register_arrival` 只接受 `pending_arrival`。
3. 資料庫另有一道 `devices` 狀態轉換觸發器，比對允許的轉換表。就算是後台直接下 SQL，非法的轉換也會被擋下（除非明確走管理者更正流程）。
4. CHECK 約束確保每個狀態都有該有的欄位，例如 `delivered` 一定有交付時間、SN 和到貨時間。

**時間與操作者：** 一律在函式內使用 `now()` 和 `auth.uid()`，函式不接受前端傳來的時間或操作者。

**多人同時操作：** RPC 會帶入前端看到的 `expected_status`（或 `version`）。如果和資料庫目前的值不一致，就回傳 `STATE_CHANGED` 錯誤，前端重新載入最新資料。

---

## 3. 資料庫 schema（第一階段先全部建好，第二到四階段只加函式）

> 這是確認用的設計稿，正式 migration 會依此撰寫。

```sql
-- ── 列舉 ───────────────────────────────────────────────
create type app_role      as enum ('staff', 'manager', 'admin');
create type device_status as enum ('pending_arrival','arrived_pending_notify',
                                   'notified_pending_pickup','delivered',
                                   'excluded','cancelled');
create type item_source   as enum ('manual', 'ocr');

-- ── 門市與使用者 ─────────────────────────────────────────
create table stores (
  code        text primary key check (code ~ '^[A-Za-z0-9_-]+$'),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table profiles (                      -- 內部使用者；登入身分來自 Firebase（§2.1）
  user_id       uuid primary key default gen_random_uuid(),  -- 所有 *_by 欄位都指向這裡
  auth_iss      text not null,               -- https://securetoken.google.com/<project-id>
  auth_uid      text not null,               -- Firebase UID（token 的 sub）
  email         text not null,
  display_name  text not null,
  role          app_role not null default 'staff',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (auth_iss, auth_uid),
  unique (email)
);

create table user_stores (
  user_id     uuid references profiles(user_id),
  store_code  text references stores(code),
  primary key (user_id, store_code)
);

-- ── 訂單 ─────────────────────────────────────────────
create table orders (
  id                  uuid primary key default gen_random_uuid(),
  order_no            text not null unique,          -- 例如 PO-A01-20261025-0003
  store_code          text not null references stores(code),
  customer_name       text not null check (btrim(customer_name) <> ''),
  customer_phone      text not null check (customer_phone ~ '^[0-9+\-# ]{6,20}$'),
  customer_code       text,
  purchase_date       date not null,
  register_no         text not null check (register_no ~ '^[0-9A-Za-z]+$'),  -- 保留 '011'
  receipt_seq         text not null check (receipt_seq ~ '^[0-9A-Za-z]+$'),
  receipt_no          text,
  order_note          text,
  duplicate_ack_reason text,                          -- 疑似重複時，同仁確認的原因
  client_request_id   uuid not null unique,           -- 防止重複送出
  version             int  not null default 1,
  created_by          uuid not null references profiles(user_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  cancelled_at        timestamptz,
  cancelled_by        uuid references profiles(user_id),
  cancellation_reason text,
  check ((cancelled_at is null) = (cancelled_by is null)
     and (cancelled_at is null or btrim(coalesce(cancellation_reason,'')) <> ''))
);
create unique index orders_receipt_no_uniq                -- A4 硬性重複
  on orders (store_code, upper(btrim(receipt_no)))
  where receipt_no is not null and cancelled_at is null;
create index on orders (store_code, register_no, receipt_seq, purchase_date);
create index on orders (customer_phone);

-- ── 商品明細 ───────────────────────────────────────────
create table order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),
  line_no             int  not null,
  product_code        text,
  full_product_name   text not null check (btrim(full_product_name) <> ''),
  model               text,
  color               text,
  ordered_qty         int  not null check (ordered_qty > 0),  -- 等於未取消的單機數（M1）
  item_note           text,
  source              item_source not null default 'manual',
  import_draft_id     uuid,                                    -- 第四階段才加 FK
  version             int  not null default 1,
  created_by          uuid not null references profiles(user_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  cancelled_at        timestamptz,
  cancelled_by        uuid references profiles(user_id),
  cancellation_reason text,
  unique (order_id, line_no)
);

-- ── 單機 ─────────────────────────────────────────────
create table devices (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),       -- 冗餘欄位，方便 RLS 與查詢
  order_item_id       uuid not null references order_items(id),
  unit_no             int  not null check (unit_no > 0),
  sn                  text check (sn is null or sn = upper(btrim(sn))),
  status              device_status not null,
  is_labeled          boolean not null default false,
  labeled_at          timestamptz,
  labeled_by          uuid references profiles(user_id),
  arrived_at          timestamptz,
  arrived_by          uuid references profiles(user_id),
  last_notified_at    timestamptz,                               -- 最近一次成功通知
  delivered_at        timestamptz,
  delivered_by        uuid references profiles(user_id),
  delivery_note       text,
  excluded_at         timestamptz,
  excluded_by         uuid references profiles(user_id),
  exclusion_reason    text,
  cancelled_at        timestamptz,
  cancelled_by        uuid references profiles(user_id),
  cancellation_reason text,
  status_before_cancel device_status,                             -- 恢復取消用（S5）
  version             int  not null default 1,
  created_by          uuid not null references profiles(user_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (order_item_id, unit_no),

  -- 各狀態必須具備的欄位（S4：到貨後 SN 必填）
  check (status not in ('arrived_pending_notify','notified_pending_pickup','delivered')
         or (arrived_at is not null and arrived_by is not null and sn is not null)),
  check (status <> 'notified_pending_pickup' or last_notified_at is not null),
  check (status <> 'delivered' or (delivered_at is not null and delivered_by is not null)),
  check (status <> 'pending_arrival' or (arrived_at is null and delivered_at is null)),
  check (status <> 'excluded'
         or (excluded_at is not null and btrim(coalesce(exclusion_reason,'')) <> '')),
  check (status <> 'cancelled'
         or (cancelled_at is not null and btrim(coalesce(cancellation_reason,'')) <> '')),
  check (not is_labeled or (labeled_at is not null and labeled_by is not null))
);
create unique index devices_sn_uniq on devices (sn)                -- M4
  where sn is not null and status <> 'cancelled';
create index on devices (status) where status in
  ('pending_arrival','arrived_pending_notify','notified_pending_pickup');
create index on devices (order_id);

-- ── 通知 ─────────────────────────────────────────────
create table notification_methods  (code text primary key, label text not null, sort int);
create table notification_outcomes (code text primary key, label text not null,
                                    is_success boolean not null, sort int);
create table notifications (                       -- 只能新增
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null,                      -- M6
  device_id    uuid not null references devices(id),
  order_id     uuid not null references orders(id),
  notified_at  timestamptz not null default now(),
  operator_id  uuid not null references profiles(user_id),
  method       text not null references notification_methods(code),
  outcome      text not null references notification_outcomes(code),
  is_success   boolean not null,                   -- 寫入當下的快照，之後改對照表也不受影響
  note         text,
  created_at   timestamptz not null default now()
);

-- ── 稽核 ─────────────────────────────────────────────
create table audit_logs (                          -- 只能新增，由觸發器寫入
  id                  bigint generated always as identity primary key,
  occurred_at         timestamptz not null default now(),
  txn_id              bigint not null default txid_current(),  -- 同一個操作的事件可以分組
  store_code          text,
  order_id            uuid,
  order_item_id       uuid,
  device_id           uuid,
  entity_type         text not null,               -- order / order_item / device / notification / profile ...
  entity_id           text not null,
  action              text not null,               -- create_order / register_arrival / ... / direct_db_change
  actor_user_id       uuid,                        -- 沒有登入身分（後台直接操作）時為 null
  actor_display_name  text,                        -- 當下的姓名快照
  actor_db_role       text not null default current_user,
  before_data         jsonb,
  after_data          jsonb,
  changed_fields      text[],
  reason              text,
  metadata            jsonb
);
create index on audit_logs (order_id, occurred_at desc);
create index on audit_logs (device_id, occurred_at desc);

-- ── OCR 草稿（第四階段才啟用，第一階段先建表） ───────────────
create table import_drafts (
  id                  uuid primary key default gen_random_uuid(),
  store_code          text not null references stores(code),
  image_storage_path  text not null,               -- 私有 bucket 內的路徑
  ocr_raw_result      jsonb,
  parsed_fields       jsonb,
  status              text not null default 'pending'
                      check (status in ('pending','confirmed','discarded','failed')),
  order_id            uuid references orders(id),
  created_by          uuid not null references profiles(user_id),
  created_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  confirmed_by        uuid references profiles(user_id)
);

-- ── 訂單編號流水號 ─────────────────────────────────────
create table order_no_counters (
  store_code text, day date, last_seq int not null default 0,
  primary key (store_code, day)
);
```

### 3.1 計算用的 view（統計不靠人工維護）

- `v_order_summary`：每張訂單的商品數、單機總數、各狀態台數、已交付數、衍生狀態（進行中、已完成、已取消）。
- `v_device_todo`：待到貨、待通知、待貼標（S1 定義）、待取貨的台數。excluded 和 cancelled 不計入。
- 兩個 view 都使用 `security_invoker = on`，自動套用查詢者的 RLS。

### 3.2 權限策略（RLS）

輔助函式（security definer，避免 RLS 遞迴）：
- `app.current_profile()`：用 `auth.jwt()->>'iss'` 和 `->>'sub'` 對應到 `profiles`，只回傳啟用中的帳號。
- `app.current_role()`：取得目前使用者的角色。若帳號已停用或查不到，回傳 null。
- `app.can_access_store(code)`：admin 一律可以；其他角色必須在 `user_stores` 裡有該門市。

| 資料表 | SELECT | INSERT / UPDATE / DELETE |
|--------|--------|--------------------------|
| stores | 已登入且帳號啟用 | 只能透過 admin RPC |
| profiles | 自己；manager 可看同門市成員；admin 可看全部 | 只能透過 admin RPC |
| user_stores | 自己；admin 可看全部 | 只能透過 admin RPC |
| orders / order_items / devices / notifications | `can_access_store(訂單的門市)` | **全部撤銷**，只能透過 RPC |
| audit_logs | `can_access_store(store_code)`；門市以外的事件（例如帳號管理）只有 admin 能看 | **全部撤銷**，另有觸發器禁止 UPDATE、DELETE |
| import_drafts | 建立者本人加上同門市的 manager 以上 | 只能透過 RPC |

做法：`revoke insert, update, delete on all tables in schema public from anon, authenticated;`，另外 `anon` 連 SELECT 都沒有。

### 3.3 稽核機制（A1）

1. 每個 RPC 一開始執行 `perform app.begin_action('register_arrival', reason)`。這個函式會在本次交易內設定 `app.action`、`app.reason`，以及操作者和姓名快照。
2. `orders`、`order_items`、`devices`、`notifications`、`profiles`、`user_stores`、`stores` 和兩張對照表，都掛上同一個 `AFTER INSERT/UPDATE/DELETE` 觸發器 `app.audit_row()`：
   - 寫入 before/after 資料（去掉 `updated_at`、`version` 等雜訊欄位），以及 `changed_fields`。
   - 如果沒有設定 `app.action`，`action` 就寫成 `direct_db_change`，代表有人繞過了正式流程。
   - 如果是 UPDATE 但沒有任何實質欄位改變，就不寫紀錄。
3. 交易回滾時，稽核紀錄也會一起回滾，所以主資料和稽核紀錄一定一致（§11-6）。
4. 個資最小化：電話照樣記錄前後值（業務追蹤需要），但不寫進應用程式的 log，也不在錯誤訊息中回傳完整電話。

### 3.4 狀態轉換表（由 `devices` 的 BEFORE UPDATE 觸發器強制執行）

| 從 | 到 | 允許的動作 | 角色 |
|----|----|------------|------|
| （新建） | pending_arrival / excluded | create_order、add_order_item、change_item_quantity | staff 以上 |
| pending_arrival | arrived_pending_notify | register_arrival | staff 以上 |
| arrived_pending_notify | notified_pending_pickup | record_notification（成功） | staff 以上 |
| notified_pending_pickup | delivered | complete_delivery | staff 以上 |
| pending / arrived / notified / excluded | cancelled | cancel_device、cancel_order、change_item_quantity | manager 以上（P3） |
| 往回退一格（S5）、excluded → pending、cancelled → 取消前的狀態 | — | correct_device_status，原因必填 | manager 以上 |
| 狀態不變 | — | set_labeled（S1）、record_notification（失敗或催取）、correct_sn | 依各函式規定 |

觸發器會用 `app.action` 比對上表。不在表中的組合一律拒絕，即使是用後台 SQL 執行也一樣。

### 3.5 第一階段的 RPC

| 函式 | 說明 |
|------|------|
| `check_duplicate_order(store, receipt_no, register_no, receipt_seq, purchase_date)` | 回傳疑似重複的訂單摘要（A4） |
| `create_order(payload jsonb)` | 一筆交易內完成：檢查權限與門市、檢查重複、產生 order_no、建立訂單、商品明細和 N 筆單機（每台的初始狀態只能是 pending 或 excluded，excluded 需要原因）。稽核紀錄由觸發器產生。 |
| `update_order_info(order_id, expected_version, patch)` | 修改顧客資料、單據資訊、備註 |
| `add_order_item(order_id, item)`、`update_order_item(item_id, expected_version, patch)` | 新增或修改商品。修改只能改名稱、型號、顏色、備註，數量不在這裡改。 |
| `change_item_quantity(item_id, new_qty, cancel_device_ids[], reason)` | 修改數量（M1） |
| `cancel_order` / `cancel_order_item` / `cancel_device` | 取消。原因必填，限 manager 以上。 |
| `admin_upsert_store`、`admin_set_user_role`、`admin_set_user_stores`、`admin_set_user_active` | 帳號與門市管理 |

第二階段再加入：`register_arrival`、`record_notification`、`set_labeled`、`complete_delivery`、`correct_sn`、`correct_device_status`。

所有 RPC 失敗時，都回傳固定的錯誤碼（例如 `SN_DUPLICATE`、`STATE_CHANGED`、`FORBIDDEN`、`DUPLICATE_RECEIPT`），前端再翻譯成中文訊息。

---

## 4. 頁面與元件清單

| 頁面 | 第一階段 | 之後的階段 |
|------|----------|------------|
| 登入 `/login` | ✅ | — |
| 首頁 `/` | ✅ 待辦數字（從 view 即時計算） | 第三階段：點數字進入篩選結果 |
| 新增訂單 `/orders/new` | ✅ 區塊 A、B（手動新增）、C（逐台初始狀態）、D（摘要）、重複單據確認、送出前確認畫面 | 第四階段：區塊 B 加入掃描新增 |
| 訂單列表 `/orders` | ✅ 最近訂單，可依單號、電話、姓名簡單搜尋 | 第三階段：完整搜尋與狀態篩選 |
| 訂單詳情 `/orders/:id` | ✅ 基本資料、商品、單機列表（唯讀）、異動時間軸、修改訂單資料、取消 | 第二階段：單機操作按鈕、通知紀錄 |
| 待辦清單 `/todo` | ❌ | 第三階段 |
| 設定 `/settings` | ✅ admin：門市、帳號角色、門市指派 | 通知結果對照表 |

共用元件：`StatusBadge`、`DeviceRow`、`AuditTimeline`（含篩選）、`ConfirmDialog`、`ReasonDialog`（原因必填）、`ErrorBanner`（把錯誤碼轉成中文）。

以手機優先設計：門市同仁多半拿手機或平板操作。

---

## 5. 分階段計畫

| 階段 | 內容 | 驗收方式 |
|------|------|----------|
| **1. 核心資料與權限** | migration（第 3 節全部）、RLS、稽核觸發器、狀態轉換觸發器、第一階段 RPC、登入、手動建立訂單、訂單詳情（唯讀）加時間軸、帳號管理、部署 | 資料庫自動化測試全部通過；可以在線上網址登入並建立訂單 |
| 2. 單機作業流程 | 到貨與 SN、通知（成功、失敗、批次）、已貼、交付、管理者更正 | 測試加上手機實測 |
| 3. 查詢與工作台 | 完整搜尋、篩選、待辦清單、電話遮罩 | 測試 |
| 4. OCR | 私有上傳、Edge Function 呼叫 OCR、草稿確認、和手動新增混用 | 需要先確定 OCR 服務商並取得公司核准 |
| 5. 上線 | 備份與 PITR、錯誤監控、資料保留政策、操作手冊 | 驗收清單 §14 |

### 5.1 第一階段的測試案例（資料庫層，自動化）

權限
- T01：未登入（anon）讀取任何資料表都拿不到資料。
- T02：staff 用 SELECT 讀不到其他門市的訂單和稽核紀錄。
- T03：staff 直接 `insert/update/delete` 任何資料表都被拒絕。
- T04：staff 呼叫 `cancel_order` 回傳 FORBIDDEN。
- T05：帳號停用後，所有 RPC 都回傳 FORBIDDEN。

建立訂單
- T10：數量 3 的商品建立 3 筆單機，`unit_no` 為 1、2、3。
- T11：傳入初始狀態 `delivered` 或 `arrived_pending_notify` 會被拒絕，而且整筆交易回滾（訂單、商品都不會留下）。
- T12：選擇 excluded 但沒有原因會被拒絕；有原因時，會記錄排除人和排除時間。
- T13：同門市、相同 `receipt_no` 的第二張訂單會被拒絕；取消第一張之後就可以建立。
- T14：收銀機號、序號、日期相同但沒有填 receipt_no 時，沒有勾選確認會被拒絕，勾選確認後才能建立。
- T15：同一個 `client_request_id` 送兩次，只會建立一張訂單。
- T16：`register_no = '011'` 存入後讀出仍是 `'011'`。

狀態與稽核
- T20：用後台 SQL 直接把 pending 改成 delivered，會被狀態觸發器拒絕。
- T21：直接用 SQL 修改訂單備註，稽核紀錄中會出現 `direct_db_change`。
- T22：`create_order` 會產生訂單、每個商品、每台單機的稽核事件，而且這些事件的 `txn_id` 相同。
- T23：`update_order_info` 的稽核紀錄有 before/after 和 changed_fields，並記錄操作者和姓名快照。
- T24：即使用最高權限，也不能 update/delete/truncate `audit_logs`。
- T25：`change_item_quantity` 從 3 改成 2，指定的那台單機變成 cancelled 而不是被刪除，`ordered_qty` 與未取消的單機數一致。
- T26：在 SN 已被取消的單機上使用，SN 不再佔用唯一索引（為第二階段預先驗證）。

前端（第一階段手動驗收）
- 用手機和桌機分別登入，建立含 2 個商品（共 5 台）的訂單，其中 1 台設為 excluded，接著在詳情頁的時間軸確認事件。

---

## 6. 開發與部署方式

- 目前這台電腦有 Node 26，但沒有 Docker 和 Supabase CLI。
- **資料庫測試**：用 PGlite（以 WASM 執行的 PostgreSQL，透過 npm 安裝，不需要 Docker）在本機跑 migration 和上面的測試，並模擬 Supabase 的 `auth.jwt()`（帶 Firebase 格式的 iss/sub）與 `authenticated` 角色。另外測試「Firebase 有帳號但 profiles 查不到的人什麼都讀不到」，以及「其他 Firebase 專案發出的 token 會被拒絕」。正式環境的 RLS 會在 Supabase 的開發專案上再驗證一次。
- **你需要準備**：
  1. **Supabase 專案**（建議分開開 `dev` 和 `prod`，免費方案先用 dev）：需要專案 URL、anon key，以及資料庫連線字串（只在本機用來 push migration，不會進 git 或前端）。
  2. **Firebase 專案**（私人帳號，免費的 Spark 方案即可）：只啟用 Authentication 的 Email/Password。需要 Web App 的設定值（apiKey、authDomain、projectId），以及一份服務帳戶金鑰 JSON（**只會放進 Supabase Edge Function 的 secret，不會進 git**）。
  3. **GitHub repo**：決定公開還是私有（§2.2）。部署用 GitHub Actions，Firebase 和 Supabase 的公開設定值放在 repo 的 Actions variables。
- 專案結構預計是：

```
customer/
  docs/                 規格與設計
  supabase/migrations/  SQL migration（依序編號）
  supabase/seed.sql     門市、通知對照表的初始資料（不含假訂單）
  db-tests/             PGlite 自動化測試
  web/                  React 前端
```

---

## 7. 尚未實作或不在範圍內（明確標示）

- 第二到第五階段的所有功能，包括到貨、通知、貼標、交付、OCR、完整搜尋、待辦清單、電話遮罩。
- 雙人核准流程（P2）、記錄被拒絕的操作（A2）、退貨與換貨（S7）、共用 `customers` 表（M3）。
- 資料保留期限與刪除程序：需要公司提供政策。
