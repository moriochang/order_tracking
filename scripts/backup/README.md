# 資料庫備份（Mac mini → Google 雲端硬碟）

每天 03:00 由 Mac mini 執行 `pg_dump`，把資料庫（結構、資料、異動紀錄）壓縮存進 Google 雲端硬碟電腦版的同步資料夾，
再由雲端硬碟自動上傳。

- 檔名：`order_tracking_YYYYMMDD_HHMM.sql.gz`（台北時間）
- 資料夾：Google 雲端硬碟裡的 `預購商品追蹤_資料庫備份`
- 保留：最近 60 天每天一份（約 30 MB），超過 60 天自動刪除
- 連線字串（含資料庫密碼）只存在 Mac mini 的鑰匙圈，不寫進任何檔案，也不進 repo

## 第一次設定（在 Mac mini 上）

```bash
git clone https://github.com/moriochang/order_tracking.git
cd order_tracking/scripts/backup
./setup.sh
```

照畫面指示：貼上 Supabase 的 Session pooler 連線字串、把雲端硬碟裡的備份資料夾拖進視窗。
設定完會立刻備份一次做測試。

注意：Mac mini 要保持登入狀態（鑰匙圈解鎖），排程才讀得到連線字串。

## 日常檢查

- 雲端硬碟資料夾裡每天會多一個檔案
- 執行紀錄：`~/order-tracking-backup/backup.log`
- 手動備份：`~/order-tracking-backup/backup.sh`

## 還原

還原到**新建的** Supabase 專案（不要覆蓋正在使用的資料庫）：

1. 建立新專案，在 Authentication → Third-Party Auth 加入同一個 Firebase 專案。
2. 取得新專案的 Session pooler 連線字串，然後執行：
   ```bash
   gunzip -c order_tracking_YYYYMMDD_HHMM.sql.gz | "$(brew --prefix libpq)/bin/psql" "新專案的連線字串"
   ```
3. 重新部署 Edge Functions（admin-users、ocr-receipt）與 Secrets，前端改用新專案的網址與 publishable key。

備份內的觸發器在資料匯入之後才建立，所以還原時不會重複寫入異動紀錄，也不會被狀態檢查擋下。

還原時會出現兩種錯誤訊息，都不影響資料，可以忽略（2026-10-28 演練確認）：

- `schema "public" already exists`
- `role "supabase_admin" does not exist`（只在非 Supabase 的資料庫出現）

psql 需為 18 版（備份由 pg_dump 18 產生，檔案內有 psql 18 才認得的 `\restrict` 指令）。演練紀錄見 `docs/backup/`。
