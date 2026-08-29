# Claude Desktop 繁體中文（台灣）

由 **南山網絡** 製作與維護。

在 Claude Desktop 的語言選單中新增一個「繁體中文」選項，英文與其他既有語言全部保留。

> ### 系統需求
>
> **僅支援 macOS。Windows 與 Linux 無法使用。**
>
> 本工具依賴 `codesign`（重新簽章）、`launchctl`（背景服務）、macOS 鑰匙圈與
> `/Applications` 的 App Bundle 結構。這些是 macOS 專有機制，其他系統沒有對應
> 實作，無法移植。
>
> - 開發與測試環境：macOS 26.5、Apple Silicon
> - Intel Mac 理論上可用（處理通用二進位檔），但未經實測
> - 需要已安裝 Claude Desktop

---

## 快速開始

1. 下載並解壓縮本資料夾
2. 雙擊 **`安裝繁體中文.command`**
3. 閱讀畫面上的說明，輸入 `y` 確認
4. 等待 1-3 分鐘（重新簽章需要時間）
5. 自行開啟 Claude，首次開啟時輸入一次 Mac 登入密碼，點選**「永遠允許」**

要移除時，雙擊 **`還原官方版.command`**。

> 首次雙擊若出現「無法打開，因為來自身分不明的開發者」，請在該檔案上按住 Control 點一下，選「打開」，再於對話框中確認。

---

## 這是什麼

Claude Desktop 官方支援 11 種語言，不含中文。本工具在語言選單新增「繁體中文」，並提供 25,567 條介面字串的翻譯。

| 範圍 | 覆蓋率 |
|---|---|
| 主介面 | 100% |
| 模型選單 | 100% |
| 桌面外殼與設定頁 | 100% |

譯自英文原文，非簡轉繁機器轉換。術語以 400 條台灣詞彙表統一：螢幕／軟體／檔案／預設／資料夾／權限／連接器／專案／工作階段。Claude、Artifact、Cowork、MCP、API、Opus、Sonnet、Token 等維持原文。

安裝後語言選單長這樣：

```
中文（台灣）            ← 新增
English (United States) ← 保留
Français (France)
Deutsch (Deutschland)
हिन्दी (भारत)
Indonesia (Indonesia)   ← 保留
Italiano (Italia)
日本語 (日本)
한국어(대한민국)
Português (Brasil)
Español (Latinoamérica)
Español (España)
```

---

## 運作方式

Claude 的主介面從 `claude.ai` 線上載入，而非打包在 App 內。本工具在 Electron 主行程攔截 Claude 自己的語言檔請求，把繁體中文的語言包交給 Claude 內建的 React i18n 系統渲染 —— 與官方語言走同一條路徑。

這不是畫面文字替換，因此不會閃爍、不會漏字、不會與輸入法衝突。

攔截範圍僅三種請求：語言檔、帳號啟動資料、以及線上資源中含語言清單的那一個檔案。其餘一律原樣通過。

---

## 代價

**請在安裝前讀完這一節。**

### 1. 更新來源驗證會放寬

Claude 使用 Squirrel 進行內建更新，它會拿「正在執行的 App 的簽章需求」去驗證下載回來的更新包。本工具重新簽章後，這項驗證原本會永遠失敗，導致內建更新完全無法使用。

為了讓內建更新繼續可用，本工具在簽章中寫入一條放寬的需求：

```
(Anthropic 官方憑證)  或  (相同 bundle id 且非 Apple 錨定)
```

左半使官方更新驗得過，右半使本工具自己的版本也滿足。

**代價是：** 任何「宣告相同 bundle id 且未經 Apple 簽署」的程式碼都能通過這項驗證。也就是說，能寫入 Claude 更新快取目錄的人，可以放一份未簽章的假更新。

前提是對方已經能在你的帳號下執行程式碼與寫入檔案 —— 到那個地步，對方有更省事的攻擊手段。這是知情下選擇的取捨；不接受的話，請不要安裝。

### 2. 部分功能失效

以下功能依賴綁定 Anthropic 蘋果團隊身分的兩個 entitlement，重新簽章時必須剝除，否則系統會在啟動當下終止程序：

- WebAuthn／硬體金鑰登入
- Microsoft SSO
- Cowork VM 沙箱

改用密碼或 Google 登入不受影響。

### 3. 每次安裝後要輸入一次鑰匙圈密碼

Claude 用一把存在 macOS 鑰匙圈的金鑰加密登入狀態。存取權限綁在 App 的簽章雜湊上，而重新簽章會改變雜湊，因此每次安裝後首次開啟 Claude 時，macOS 會要求一次密碼。

安裝腳本會在重新簽章後自動更新該金鑰的存取權限，這一步也需要你的密碼。密碼由 Apple 的 `security` 工具直接讀取，不經過本工具，也不會出現在程序列表中。

對話框有「允許」與「永遠允許」兩個按鈕，**請點「永遠允許」** ——「允許」只對
這一次有效，下次開啟還會再問。

不輸入也可以，Claude 仍能使用，只是需要重新登入。

**唯一能徹底消除此提示的方式是 Apple Developer ID 憑證**（開發者帳號約 US$99/年），它會提供穩定的簽章身分。本工具未使用，因為那會讓每位使用者都需要自己的憑證。

---

## Claude 更新後

Claude 內建更新可正常使用。更新完成後，App 會被官方版覆蓋，介面變回英文 —— 這是正常結果，不是故障。

安裝時會一併裝上一個背景服務，它會在偵測到這種情況時發出一則通知。收到通知後，再雙擊一次 `安裝繁體中文.command` 即可補回繁體中文。

這個背景服務：

- 只發通知，不會自行重新安裝或重新簽章
- 沒有定時器，平常完全不佔資源
- 你可以無視通知，Claude 會維持英文正常運作
- 執行 `還原官方版.command` 會一併移除它

翻譯記憶以**英文原文**索引，不受 Claude 內部改版影響。因此更新後絕大多數字串會直接沿用，只有新增的英文會暫時保持原文。

---

## 登入狀態

若你在使用中發現偶爾被登出，通常是因為金鑰存取權限未更新（見「代價」第 3 點）。執行以下指令補做，之後不會再發生：

```bash
security set-generic-password-partition-list \
  -s 'Claude Safe Storage' -a 'Claude Key' \
  -S "cdhash:$(codesign -dvvv /Applications/Claude.app 2>&1 | sed -n 's/^CDHash=//p'),teamid:Q6L2SF6YDW"
```

---

## 換一台電腦

整個資料夾複製過去，雙擊 `安裝繁體中文.command` 即可。內容不含任何綁定特定使用者的路徑。

---

## 進階指令

安裝後工具位於 `~/claude-zhtw/`：

```bash
~/claude-zhtw/bin/patch-claude status      # 版本、簽章、是否已套用、背景服務
~/claude-zhtw/bin/patch-claude install     # 安裝（--dry-run 只試跑不動 App）
~/claude-zhtw/bin/patch-claude uninstall   # 還原官方版
~/claude-zhtw/bin/patch-claude adapt       # Claude 更新後補回繁體中文
~/claude-zhtw/bin/patch-claude verify      # 重跑一次畫面健康檢查
~/claude-zhtw/bin/patch-claude rearm       # 解除自我停用狀態
```

### 補翻新版新增的字串

```bash
~/claude-zhtw/bin/patch-claude sync
# 產生 pending.json，內容為 {類別: {英文: 英文}}
# 將值翻成繁體中文，存成 {英文: 中文} 的 JSON
~/claude-zhtw/bin/patch-claude merge 你的翻譯.json
~/claude-zhtw/bin/patch-claude install
```

翻譯時請遵循 `payload/glossary.tsv` 的術語規範，並保留 ICU 訊息語法（`{count, plural, one {…} other {…}}` 中的 `plural`、`one`、`other` 是語法，不可翻譯）。

---

## 免責聲明

**本工具由南山網絡獨立製作，與 Anthropic 無任何從屬、合作或授權關係。**「Claude」為 Anthropic 之商標，本專案僅為說明用途而提及。

本工具會修改 `/Applications/Claude.app` 的內容並重新簽章。這項操作會：

- 使 App 的程式碼簽章不再是 Anthropic 官方簽章
- 放寬內建更新的來源驗證（見「代價」第 1 點）
- 使部分依賴官方簽章身分的功能失效（見「代價」第 2 點）

**使用本工具即代表你已閱讀並理解上述影響，並自行承擔全部風險。** 南山網絡不對因使用本工具而導致的任何資料遺失、功能異常、帳號問題或其他損害負責。

本工具依「現狀」提供，不附帶任何明示或默示之擔保。

每次安裝都會將原版備份至 `/Applications/Claude.backup-before-zhTW-<時間戳>.app`，隨時可透過 `還原官方版.command` 還原。

若你所處的環境對應用程式完整性有合規要求（企業受管裝置、資安政策等），請先與你的 IT 部門確認後再行安裝。

---

## 授權

翻譯內容與腳本以 MIT 授權釋出。

Claude Desktop 本身的所有權利歸 Anthropic 所有，本專案不包含、不散布任何 Anthropic 的程式碼或資產。
