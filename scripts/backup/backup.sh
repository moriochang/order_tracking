#!/bin/bash
# 預購商品追蹤：備份資料庫（結構＋資料＋異動紀錄）到 Google 雲端硬碟同步資料夾。
# 由 launchd 每天執行；也可以手動執行：  ~/order-tracking-backup/backup.sh
# 連線字串存在 macOS 鑰匙圈（服務名稱 order-tracking-db），不寫在任何檔案裡。
set -euo pipefail

CONF="$HOME/.order-tracking-backup.conf"
[ -f "$CONF" ] || { echo "找不到設定檔 ${CONF}，請先執行 setup.sh"; exit 1; }
# shellcheck source=/dev/null
source "$CONF"   # BACKUP_DIR、PG_BIN

DB_URL="$(security find-generic-password -s order-tracking-db -w 2>/dev/null)" \
  || { echo "鑰匙圈裡找不到資料庫連線字串，請重新執行 setup.sh"; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(TZ=Asia/Taipei date +%Y%m%d_%H%M)"
OUT="$BACKUP_DIR/order_tracking_${STAMP}.sql.gz"
TMP="$OUT.partial"

# 只備份本系統的 public、app 兩個 schema；不含擁有者，還原到新專案時比較單純
"$PG_BIN/pg_dump" "$DB_URL" --schema=public --schema=app --no-owner --quote-all-identifiers \
  | gzip -9 > "$TMP"
# 檢查備份完整（pg_dump 正常結束時最後一行是完成註記）
gzip -dc "$TMP" | tail -n 5 | grep -q "PostgreSQL database dump complete" \
  || { rm -f "$TMP"; echo "備份不完整，已刪除"; exit 1; }
mv "$TMP" "$OUT"
echo "$(TZ=Asia/Taipei date '+%F %T') 備份完成：${OUT}（$(du -h "$OUT" | cut -f1)）"

# 保留規則：最近 14 天每天一份；每月 1 日的備份永久保留
find "$BACKUP_DIR" -name 'order_tracking_*.sql.gz' -mtime +14 | while read -r f; do
  case "$(basename "$f")" in order_tracking_??????01_*) ;; *) rm -f "$f" ;; esac
done
