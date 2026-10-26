#!/bin/bash
# 在 Mac mini 上執行一次：安裝 pg_dump、把資料庫連線字串存進鑰匙圈、設定備份資料夾與每天自動備份。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/order-tracking-backup"
PLIST="$HOME/Library/LaunchAgents/tw.istore.order-tracking-backup.plist"

echo "== 1/4 檢查 pg_dump =="
command -v brew >/dev/null || { echo "請先安裝 Homebrew：https://brew.sh"; exit 1; }
brew list libpq >/dev/null 2>&1 || brew install libpq
PG_BIN="$(brew --prefix libpq)/bin"
"$PG_BIN/pg_dump" --version

echo
echo "== 2/4 資料庫連線字串 =="
echo "到 Supabase 專案 → 上方「Connect」→「Session pooler」，複製 URI，並把 [YOUR-PASSWORD] 換成資料庫密碼。"
read -r -s -p "貼上連線字串（不會顯示在畫面上）：" DB_URL; echo
[[ "$DB_URL" == postgres* ]] || { echo "格式不對，應該以 postgresql:// 開頭"; exit 1; }
"$PG_BIN/psql" "$DB_URL" -Atc "select 'ok, 訂單數：' || count(*) from public.orders" \
  || { echo "連線失敗，請檢查連線字串與密碼"; exit 1; }
security add-generic-password -U -s order-tracking-db -a "$USER" -w "$DB_URL"
echo "已存進鑰匙圈（服務名稱 order-tracking-db）"

echo
echo "== 3/4 備份資料夾 =="
echo "在 Finder 打開 Google 雲端硬碟，建立（或選擇）要放備份的資料夾，把它拖進這個視窗後按 Enter。"
read -r -p "備份資料夾：" BACKUP_DIR
BACKUP_DIR="$(echo "$BACKUP_DIR" | sed -e "s/^'//" -e "s/'$//" -e 's/\\ / /g' -e 's/[[:space:]]*$//')"
mkdir -p "$BACKUP_DIR"
printf 'BACKUP_DIR=%q\nPG_BIN=%q\n' "$BACKUP_DIR" "$PG_BIN" > "$HOME/.order-tracking-backup.conf"

echo
echo "== 4/4 每天 03:00 自動備份 =="
mkdir -p "$INSTALL_DIR"
cp "$HERE/backup.sh" "$INSTALL_DIR/backup.sh"
chmod +x "$INSTALL_DIR/backup.sh"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>tw.istore.order-tracking-backup</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$INSTALL_DIR/backup.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$INSTALL_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/backup.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/tw.istore.order-tracking-backup" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "先執行一次備份測試："
"$INSTALL_DIR/backup.sh"
echo
echo "完成。之後每天 03:00 自動備份（Mac mini 若在睡眠，醒來後會補做），紀錄在 $INSTALL_DIR/backup.log"
