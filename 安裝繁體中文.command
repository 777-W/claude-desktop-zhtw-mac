#!/bin/bash
# Claude Desktop 繁體中文（台灣）— 安裝腳本
# 南山網絡  https://github.com/
#
# 首次安裝與 Claude 更新後重新套用是同一個動作，重複執行安全。
# 僅支援 macOS。整套流程依賴 codesign、launchctl、/Applications 與 macOS 鑰匙圈，
# Windows 與 Linux 沒有對應機制，無法移植。
if [ "$(uname -s)" != "Darwin" ]; then
  echo "本工具僅支援 macOS。偵測到的系統：$(uname -s)"
  exit 1
fi

cd "$(dirname "$0")" || exit 1
SRC="$PWD/payload"; DEST="$HOME/claude-zhtw"; APP="/Applications/Claude.app"
PC="/usr/bin/python3 $DEST/bin/patch-claude"

# 用 ps 的 comm 判斷，不用 pgrep -f：後者讀 argv，看不到 Claude 主程序。
running() { ps -axo comm= | grep -qF "$APP/"; }

printf '\033[1m\n  南山網絡 ─ Claude Desktop 繁體中文（台灣）\n'
printf '\033[0m  ─────────────────────────────────────────\n\n'

echo "  僅支援 macOS。需要已安裝 Claude Desktop。"
echo

[ -d "$APP" ] || { echo "  找不到 $APP，請先安裝 Claude Desktop。"
                   read -r -p "  按 Enter 關閉…"; exit 1; }

mkdir -p "$DEST"

# 複製檔案。內容相同就跳過；不同就先把目的檔存進 backups/ 再覆蓋，並逐檔列出。
SNAP="$DEST/backups/pre-install-$(date +%Y%m%d-%H%M%S)"
SUPERSEDED=0
install_one() {
  if [ -f "$2" ]; then
    cmp -s "$1" "$2" && return 0
    mkdir -p "$SNAP/$(dirname "$3")"
    cp -p "$2" "$SNAP/$3"
    SUPERSEDED=$((SUPERSEDED + 1))
    echo "    更新：$3"
  fi
  mkdir -p "$(dirname "$2")"
  cp -p "$1" "$2"
}
for d in bin tm payload; do
  [ -d "$SRC/$d" ] || continue
  while IFS= read -r f; do
    rel="${f#"$SRC"/}"
    install_one "$f" "$DEST/$rel" "$rel"
  done < <(find "$SRC/$d" -type f)
done
for f in glossary.tsv README.md; do
  [ -f "$SRC/$f" ] && install_one "$SRC/$f" "$DEST/$f" "$f"
done
[ "$SUPERSEDED" -gt 0 ] && echo "    （$SUPERSEDED 個檔案已更新，原檔備份於 $SNAP）"
chmod +x "$DEST/bin/"* 2>/dev/null

STATUS="$($PC status 2>/dev/null)"

if printf '%s\n' "$STATUS" | grep -q '^適配更新       : 待確認'; then
  echo "  狀態：Claude 已更新，繁體中文被官方版覆蓋。"
  echo
  echo "  補回來需要重新修補並重新簽章："
  running && echo "    · 先關閉 Claude，完成後可自行開啟"
  echo "    · 替換 /Applications/Claude.app，原版保留一份備份"
  echo "    · 下次開啟 Claude 時，macOS 會要求一次鑰匙圈密碼"
  echo
  echo "  不處理也可以，Claude 會維持英文，其他功能不受影響。"
  echo
  read -r -p "  現在重新套用？[y/N] " a
  case "$a" in [yY]*) ;; *) echo "  已取消"; exit 0;; esac

elif printf '%s\n' "$STATUS" | grep -q "已套用繁中     : 是"; then
  echo "  狀態：已安裝繁體中文。"
  echo "  重新執行會用目前的 Claude 版本重建，並重新簽章 ——"
  echo "  下次開啟 Claude 時會再要求一次鑰匙圈密碼。"
  echo
  read -r -p "  重新套用？[y/N] " a
  case "$a" in [yY]*) ;; *) echo "  已取消"; exit 0;; esac

else
  echo "  在 Claude 的語言選單新增「繁體中文」選項。"
  echo "  英文與其他既有語言全部保留。"
  echo
  echo "  安裝會做這些事："
  echo "    · 關閉 Claude 一次（替換整個 App，無法在執行中進行）"
  echo "    · 替換 /Applications/Claude.app，原版保留一份備份"
  echo "    · 安裝一個背景服務，Claude 更新後發出通知提醒你"
  echo "      它只發通知，不會自行重新安裝或重新簽章"
  echo "    · 安裝過程不會開啟 Claude，完成後由你自行開啟"
  echo
  echo "  請先了解以下代價："
  echo "    · Claude 內建更新仍可使用，但更新來源的驗證會放寬"
  echo "    · WebAuthn／硬體金鑰登入、Microsoft SSO、Cowork VM 沙箱將失效"
  echo "      改用密碼或 Google 登入不受影響"
  echo "    · 每次安裝後首次開啟 Claude 時，會要求一次鑰匙圈密碼"
  echo "      僅用於讀取 Claude 自己的登入狀態金鑰"
  echo
  echo "  完整說明與免責聲明請見 README.md。"
  echo
  read -r -p "  要繼續嗎？[y/N] " a
  case "$a" in [yY]*) ;; *) echo "  已取消"; exit 0;; esac
fi

# 移除舊版背景服務。舊版會在 Claude 更新後自行重新簽章，本版改為只發通知。
for L in com.nanyu.claude-zhtw.watch com.nanyu.claude-zhtw.reapply \
         com.nanyu.claude-zhtw.reapply.await-quit com.claude.zhtw.reapply com.nanshan.claude-zhtw.reapply \
         com.nanshan.claude-zhtw.reapply.await-quit; do
  launchctl bootout "gui/$(id -u)/$L" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/$L.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done

if running; then
  echo; echo "  關閉 Claude…"
  osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1
  for _ in $(seq 1 30); do running || break; sleep 1; done
  if running; then
    echo "  Claude 未回應，強制結束"
    ps -axo pid=,comm= | grep -F "$APP/" | awk '{print $1}' | xargs -r kill -9 2>/dev/null
    sleep 3
  fi
fi
running && { echo "  無法關閉 Claude，已中止，App 未更動。"
             read -r -p "  按 Enter 關閉…"; exit 1; }

echo "  安裝中，重新簽章需要 1-3 分鐘…"
echo
$PC install; S=$?
echo
if [ $S -ne 0 ]; then
  echo "  安裝失敗（結束碼 $S）。"
  echo "  替換前會先驗證新版本能否啟動，未通過就不會動到 /Applications，"
  echo "  因此失敗時你的 Claude 通常維持原狀。"
  read -r -p "  按 Enter 關閉…"; exit $S
fi

echo "  安裝完成。請自行開啟 Claude，介面即為繁體中文。"
echo
echo "  首次開啟時 macOS 會要求鑰匙圈密碼。"
echo "  請輸入密碼後點選「永遠允許」——「允許」只對這一次有效，"
echo "  下次開啟還會再問。"
echo "  每次重新安裝都會再問一次。"
echo
echo "  Claude 內建更新可正常使用。更新後 App 會變回官方英文版，"
echo "  背景服務會發出通知，屆時再執行一次本腳本即可補回繁體中文。"
echo
read -r -p "  按 Enter 開啟 Claude，或直接關閉此視窗…"
open -a "$APP" 2>/dev/null
