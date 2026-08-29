#!/bin/bash
# Claude Desktop 繁體中文（台灣）— 還原腳本
# 南山網絡
# 僅支援 macOS。整套流程依賴 codesign、launchctl、/Applications 與 macOS 鑰匙圈，
# Windows 與 Linux 沒有對應機制，無法移植。
if [ "$(uname -s)" != "Darwin" ]; then
  echo "本工具僅支援 macOS。偵測到的系統：$(uname -s)"
  exit 1
fi

cd "$(dirname "$0")" || exit 1
DEST="$HOME/claude-zhtw"; APP="/Applications/Claude.app"
running() { ps -axo comm= | grep -qF "$APP/"; }

printf '\033[1m\n  南山網絡 ─ 還原 Claude 官方版\n'
printf '\033[0m  ─────────────────────────────\n\n'

echo "  將 /Applications/Claude.app 換回安裝前備份的官方版本。"
echo
echo "  還原後："
echo "    · 介面回到英文"
echo "    · WebAuthn／硬體金鑰登入、Microsoft SSO、Cowork VM 沙箱恢復"
echo "    · 開啟時不再要求鑰匙圈密碼"
echo "    · 更新通知服務一併移除"
echo
read -r -p "  要繼續嗎？[y/N] " a
case "$a" in [yY]*) ;; *) echo "  已取消"; exit 0;; esac

for L in com.nanyu.claude-zhtw.watch com.nanyu.claude-zhtw.reapply \
         com.nanyu.claude-zhtw.reapply.await-quit com.nanshan.claude-zhtw.watch com.claude.zhtw.reapply \
         com.nanshan.claude-zhtw.reapply com.nanshan.claude-zhtw.reapply.await-quit; do
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

B="$DEST/bin/patch-claude"; [ -x "$B" ] || B="$PWD/payload/bin/patch-claude"
echo; /usr/bin/python3 "$B" uninstall; S=$?
echo
[ $S -ne 0 ] && { echo "  還原失敗（結束碼 $S）"; read -r -p "  按 Enter 關閉…"; exit $S; }

echo "  已還原為官方版。"
echo
read -r -p "  按 Enter 開啟 Claude，或直接關閉此視窗…"
open -a "$APP" 2>/dev/null
