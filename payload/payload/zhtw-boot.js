// Claude 繁體中文 — main-process boot shim（真 zh-TW locale）
//
// 目標：把 zh-TW 當成 App 原生就支援的語言「加進」白名單（不取代任何語言）。
// 這樣日期、相對時間、數字、排序全部由 ICU 以 zh-TW 產出，天生是中文。
//
// ────────────────────────────────────────────────────────────────────────
// 為什麼不是 protocol.handle('https')
// ────────────────────────────────────────────────────────────────────────
// 上一版用 ses.protocol.handle('https', …) 接管整個 https scheme，只為了改寫
// 一支 chunk。實機結果：ses.fetch(req,{bypassCustomProtocolHandlers:true}) 對
// 大量請求回 net::ERR_FAILED（boot.log 出現 98 行「放行也失敗」），頁面全黑。
// 根因：接管整個 scheme 等於要自己重做完整 HTTP 路徑（串流、認證、cookie、
// Range、WebSocket 升級、預檢…），任何一個沒覆蓋到的邊角就會整個垮掉。
// 本版改成**最窄攔截**：只用 webRequest.onBeforeRequest 對「已經確認命中的
// 那一支 chunk」與 i18n / bootstrap 三類 URL 做重導，其餘所有 https 流量
// 一律不經過我們的程式碼。
//
// ────────────────────────────────────────────────────────────────────────
// 由實測確認、必須同時處理的陷阱
// ────────────────────────────────────────────────────────────────────────
//  1) protocol.registerSchemesAsPrivileged() 是「取代」不是「附加」。Claude
//     自己會再呼叫它三次，把我們註冊的 zhtw scheme 權限整個抹掉 —— handler
//     仍安裝成功卻永遠不被呼叫。解法：包裹它，改成合併。
//  2) Electron 每個 session 的每個事件只保留一個 webRequest 監聽器。Claude 在
//     ready 後會註冊自己的 onBeforeRequest，把我們的擠掉。解法：包裹它，讓
//     App 的監聽器串接在我們之後，而不是取代。
//  3) 主行程自己發出的 ses.fetch() **會**再次經過本 session 的 onBeforeRequest。
//     所以任何「重導到 zhtw:// 再由 handler 重發」的路徑都必須有防迴圈令牌，
//     否則無限遞迴。本檔用 selfFetch 令牌（markSelf/takeSelf）統一處理。
//  4) 只重導單一 chunk 會把模組圖劈成兩份：module map 的 key 是**請求前**的
//     URL，但模組自身的 base URL 是**重導後**的 URL。所以從 zhtw base 匯入
//     "./dep.js" 與從 https base 匯入 "./dep.js" 會變成兩個 key ⇒ 同一份模組
//     被實例化兩次（兩份 React、兩套 context）。
//     解法：把被改寫那支 chunk 裡**所有**相對 specifier 就地改寫成對「原始
//     https base」的絕對 URL，並把 import.meta.url 換成原始 URL 字面量。
//     這樣它的相依模組仍以原本的 https URL 為 key，模組圖不分裂。
//
// ────────────────────────────────────────────────────────────────────────
// 白名單 chunk 光看 URL 就認得出來（就地探測的前提）
// ────────────────────────────────────────────────────────────────────────
// 舊版把「哪一支 chunk 含 locale 白名單」當成非讀 body 不可的問題，所以
// discovery 只能在背景跑、下一次啟動才生效。這個前提是錯的：檔名本身就夠。
// 本機實測四個互相獨立的 build，形狀完全一致：
//   本機 bundle        .../assets/v1/shared-2-DjvNCUSW.js
//   遠端（較早）       .../assets/v1/shared-2-CGsBZhm2.js
//   遠端（安裝當下）   .../assets/v1/shared-2-BfUvjjvm.js
//   遠端（目前）       .../assets/v1/shared-2-8TRRKqAc.js
// 對 /Applications 內建 bundle 全 2200 支 JS 掃描（用的就是下面的
// patchLocaleWhitelist 本尊）：patchLocaleWhitelist 命中 1 支，符合
// CHUNK_RE 形狀的也是 1 支，而且是同一支（集合相等）。
// ⇒ 每次啟動的候選集合只有 1 個 URL，就地探測的代價是「一支檔案多抓一次」，
//   而且只在還沒有驗證過的改寫結果時才發生。所以第一次啟動就能是中文。
//
// 但形狀比對終究是經驗規律，不是合約：Claude 換 bundler 設定就可能讓白名單
// 落到別支 chunk。所以背景 discovery **原封不動保留**成後備 —— 就地探測抓到
// 一支 shared-2 卻發現裡面沒有白名單時，其餘 chunk 仍照舊在背景被掃過。
//
// ────────────────────────────────────────────────────────────────────────
// zh-TW 只存在於這台機器 —— 它可以進介面，不可以進送出去的 payload
// ────────────────────────────────────────────────────────────────────────
// 迴歸實錄（2026-08-20）：介面正常是繁體中文，但一送訊息就跳
//     locale: Input should be 'en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP',
//             'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR' or 'id-ID'
// 追下去的鏈路（線上 build shared-2-DBb3I6k4 / shared-5-Dtsk1USY）：
//   config.json 的 locale=zh-TW
//     -> index 的 Ow() 讀桌面 preferences，用 shared-2 的 Sv() 對白名單協商
//     -> 寫 localStorage['spa:locale'] 並 setLocaleOverride('zh-TW')
//     -> 生效 locale = localeOverride ?? useIntl().locale = 'zh-TW'
//     -> catalog 取 /i18n/zh-TW.json、gated 併入條件要求
//        gated_messages.locale === 生效 locale（所以 bootstrap 那一半照舊要改）
//     -> shared-5 的 nw() 組聊天送出 body：
//          locale: co.includes(e.locale) ? e.locale : Za      // co=白名單, Za="en-US"
//        e.locale 就是 useIntl().locale = 'zh-TW'
// 原版就是靠 co.includes() 這道判斷，把任何伺服器不認得的碼降級成 en-US。
// 我們把 zh-TW 塞進那個陣列，順手也把這道判斷拆了 ⇒ 送出的 body 帶 zh-TW
// ⇒ 伺服器 422，聊天完全送不出去（這是**阻斷級**的，不是背景同步的小紅字）。
// 伺服器那份清單和白名單**原版**逐字相同、連順序都一樣，這本身就是「這個陣列
// 同時是伺服器 locale 的鏡像」的證據。
//
// 因此本檔對這個陣列的改寫是**分角色**的，不是單純插一個字串：
//   列舉（map / length / 展開 / Sv 迭代）看得到 zh-TW ——語言選單有這一列、
//     開機協商得出 zh-TW，介面才會是中文；
//   成員判定（.includes）看不到 zh-TW ——凡是拿 .includes 去問「這個碼伺服器
//     認不認得」的地方（shared-5 的送出 body、shared-4 的 ?language= 連結）
//     都會照原版路徑降級成 en-US。
// 這是對「我們自己注入的那個碼」下定義，不是在關鍵路徑上加一個常駐的送出
// 改寫器 —— onBeforeRequest 本來就改不了 request body，而在送出路徑上再加一
// 個長駐元件正是先前黑畫面事故的來源。改寫後會**實際求值**驗證這兩件事同時
// 成立（verifyLocaleArrayExpr），驗不過就整支放棄、原樣放行（英文但可用）。
//
// 已知仍會外洩的一處（非阻斷、需要使用者主動操作才會碰到）：語言選單自己的
// switchLocale 會先 PUT /api/account_profile {locale:<被點的碼>} 再才寫
// localeOverride，這一支沒有經過 co.includes()。從別的語言點「繁體中文」會拿到
// 同一個 422 紅字、而且那次點選不會生效；但 config.json 已經把 zh-TW 交給
// Ow()，使用者本來就不需要去點它。要修得動到語言選單那支 lazy chunk，成本與
// 風險都比它造成的影響大，先記在這裡。
//
// ────────────────────────────────────────────────────────────────────────
// 四層 fail-safe（任何一層失敗都必須讓 App 維持可用，寧可退回英文）
// ────────────────────────────────────────────────────────────────────────
//  A) 只有在「已經握有驗證過的改寫結果」時才發出重導。就地探測有硬性逾時，
//     逾時、抓取失敗、regex 沒中、import.meta 形狀不對、雜湊不符 —— 任何一種
//     都直接放行原請求（英文但完全可用）。除了那一支 chunk 以外，沒有任何
//     請求會被壓住。
//  B) 心跳：每個主視窗載入後回報 document.body.innerText.length 與可見元素數。
//     安裝器用它判斷畫面不是空的，沒看到就自動回滾到備份。
//  C) 自我修復（同一次啟動內、不需要使用者重開）：真的在跑遠端 UI 的那個
//     webContents 若在 HEAL_WINDOW_MS 內拿不到健康心跳，就先解除本行程全部
//     改寫，再 reload 那個 webContents 一次。reload 拿到的是原始 bytes，
//     所以畫面會以英文回來。硬上限一次 —— reload 迴圈比黑畫面更糟。
//  D) 自我解除：連續 2 次「武裝了卻沒收到健康心跳」就在下一次啟動停用所有
//     改寫。使用者只要再開一次 App 就一定能拿到可用的畫面。
//
// ────────────────────────────────────────────────────────────────────────
// 這支 shim 永遠不會要求重新修補 bundle，也永遠不會觸發重簽章
// ────────────────────────────────────────────────────────────────────────
// 「Claude 變了」有兩種，代價差一個數量級，必須嚴格分開：
//
//   (1) 線上前端改版 —— .../assets/v1/shared-2-<hash>.js 換了內容雜湊。
//       磁碟上的 bundle 一個位元組都沒變，我們的注入還在。就地探測當場抓新的
//       那一支、當場改寫、當場供應：**同一次啟動就生效，不必重開 App，不碰
//       磁碟，更不必重簽章。** 這是常態，也是這段程式碼存在的主要理由。
//       就地探測失敗（形狀變了、抓不到、逾時）同樣**不需要**重簽章 —— 重簽章
//       改的是磁碟上的簽章，對線上送來的 bytes 沒有任何作用。失敗方向永遠是
//       「這一次退回英文」，僅此而已；形狀確定不符時另外記一筆
//       ZHTW-REMOTE-SHAPE，好讓 status 不會把它跟 (2) 講混。
//
//   (2) 桌面 App 本身被官方版整包換掉 —— 我們的注入一行不剩。這時候這支 shim
//       **根本不存在**，所以它在定義上不可能偵測、也不可能回報這件事。唯一
//       看得到的是 bundle 外面的觀察者（LaunchAgent 跑的 patch-claude watch），
//       而修好它一定要重新修補 asar 並重簽章 ⇒ 一定要使用者先確認
//       （patch-claude adapt）。
//
// 兩者的分界不是靠旗標判斷出來的，而是靠「誰還活著」：這支 shim 活著本身就是
// 「bundle 還是我們的」的證明，所以它看得到的一切都屬於 (1)。因此本檔任何一條
// 路徑都不得寫出「需要重新套用」的狀態、不得要求重啟、不得觸發重簽章 ——
// 那會把一個免費的線上改版誤報成一次要密碼的重簽章。
const os = require('os');
const HOME_DIR = os.homedir();
const ZDIR = HOME_DIR + '/claude-zhtw';
const LOGF = ZDIR + '/boot.log';
const log = (m) => {
  try {
    require('fs').appendFileSync(LOGF, new Date().toISOString().slice(11, 23) + ' ' + m + '\n');
  } catch (e) {}
};
log('=== boot shim 載入 ===');

// ══════════════════════════════════════════════════════════════════════════
// exec 探針早退（必須是這支檔案裡第一件有條件的事）
// ══════════════════════════════════════════════════════════════════════════
// install 在把暫存 bundle 換進 /Applications 之前會跑一次
//     <staged>/Contents/MacOS/Claude --version
// 它要證明的只有一件事：重簽過的執行檔不會在 exec 當下就被 AMFI 直接 SIGKILL
// （這個失敗模式先前產生過 "Launchd job spawn failed"）。
//
// 但 --version 對 packaged app 沒有任何特殊意義 —— Electron 照樣把主行程整個
// 跑起來：這支 shim 載入，檔尾 require 原始 main，App 就一路初始化到會碰
// Electron safeStorage 的地方，securityd 於是為登入鑰匙圈裡的
//     svce="Claude Safe Storage", acct="Claude Key"
// 彈出授權對話框。兩項實測證據：
//   * 跑一次 `Claude --version`，boot.log 的 ZHTW-BOOT 計數 +1（28 -> 29）；
//   * 該鑰匙圈項目的 ACL 裡出現過指向
//     /private/var/folders/.../T/zhtw-app.<rand>/Claude.app 的 trusted-application
//     條目 —— 那個路徑只有安裝器的暫存區會有，等於探針自己去要過授權。
// 每次安裝因此要使用者輸入兩次密碼：探針一次、他自己第一次開 App 一次。
//
// 解法：install 只在探針子行程上設一個本專案專屬的環境變數，值是一個收據檔的
// 絕對路徑；shim 在這裡就早退 —— 早於 require('electron')、早於註冊 scheme 與
// webRequest 監聽器、早於任何快取／health 檔寫入、也早於檔尾 require(原始
// main)。沒有這個變數時，一般啟動走的路徑一個位元組都沒變。
//
// 為什麼證據不走 stdout：Node 在 macOS 上對 pipe 的 process.stdout 是非同步
// 寫入，process.exit() 會把還沒沖出去的位元組丟掉。收據檔用 writeFileSync
// （同步 write(2)），路徑由安裝器指定、就在安裝器自己的暫存目錄裡，跑完即刪。
//
// 這條路徑仍然抓得到 AMFI：被 SIGKILL 的行程一行我們的程式碼都跑不到，收據
// 不會存在，而 subprocess 的 returncode 是 -9。安裝器兩者都檢查。
const PROBE_ENV = 'ZHTW_EXEC_PROBE';   // 與 patch-claude 的 PROBE_ENV 對齊
const probeReceipt = process.env[PROBE_ENV];
if (typeof probeReceipt === 'string' && probeReceipt.charAt(0) === '/') {
  let how = '';
  try {
    // 第一個 token 就是安裝器要比對的 ZHTW-PROBE-OK；寫失敗就不會有收據，
    // 安裝器因此判定探針未通過並中止 —— 失敗方向是「不動 /Applications」。
    require('fs').writeFileSync(probeReceipt,
      'ZHTW-PROBE-OK pid=' + process.pid + ' exec=' + process.execPath + '\n');
    how = 'ok';
  } catch (e) { how = 'fail:' + (e && e.message); }
  log('ZHTW-PROBE exec 探針早退：只證明 shim 載入，未 require 原始 main，'
    + '未註冊任何 handler。receipt=' + how);
  process.exit(0);
}

try {
  const { app, session, protocol } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const dir = path.join(process.resourcesPath, 'zhtw');
  const CFG = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const LOC = CFG.locale;
  const MINE = { scheme: 'zhtw', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true } };

  // 改寫語意的版本號。改寫方式一變（不只是 locale 變），舊的磁碟快取就必須
  // 作廢 —— 否則下一次啟動會拿快取裡那份「舊語意」的 body 直接供應，修好的
  // 東西等於沒修，而且完全沒有徵兆。2 = zh-TW 只供列舉、不算伺服器成員。
  const PATCH_VERSION = 2;

  const CACHE_META = path.join(ZDIR, 'chunk-cache.json');
  const CACHE_BODY = path.join(ZDIR, 'chunk-cache.js');
  const HEALTH_F = path.join(ZDIR, 'health.json');
  const PENDING_F = path.join(ZDIR, 'gated-pending.json');
  const REMOTE_EN = path.join(ZDIR, 'remote-en.json');

  // ══════════════════════════════════════════════════════════════════════
  // >>> PURE-BEGIN  ── 以下區塊不依賴 electron，測試工具會原文抽出後求值。
  //                    改動這裡務必同步跑 tools 的 rewriter 測試。
  // ══════════════════════════════════════════════════════════════════════

  // locale 白名單陣列。只認「以 "en-US" 開頭、後面 7..23 個全部帶地區次標籤的
  // BCP-47 碼」。實測（/Applications 內建 bundle 全 2180 個 chunk）：
  //   * findings §3 原本的寬鬆規則命中 3 個檔（另外兩個是語音語言清單與美洲
  //     國家清單），而它的 hits!==1 安全閥是「每檔」判斷，擋不住跨檔誤判。
  //   * 收緊後全 bundle 只剩 1 個命中，就是 shared-2 的 Cp，且重跑冪等。
  const LOCALE_ARR_RE = /\["en-US"(?:,"[a-z]{2}-[A-Za-z0-9]{2,4}"){7,23}\]/g;

  // ── 這個陣列身兼兩職，而且只有其中一職可以看到 zh-TW ──────────────────
  // 實機追出來的事實（線上 build shared-2-DBb3I6k4，2026-08-20）：這一支陣列
  // 從 shared-2 匯出（`bv as gf`），被四個地方吃掉，用法分成涇渭分明的兩類：
  //
  //   【列舉】= 「介面可以選哪些語言」——必須看得到 zh-TW
  //     shared-13  `Na.map(...)`、`Na.length`   語言選單那份清單
  //     shared-15  `[...cl,...]` + `Sv(...,ob)` 開機協商（config.json 的
  //                locale 經 index 的 Ow() 走 Sv 落到 spa:locale / localeOverride）
  //
  //   【成員判定 .includes()】= 「這個碼是不是伺服器認得的 locale」
  //                             ——絕對不可以看到 zh-TW
  //     shared-5   `nw()` 組聊天送出的 body：
  //                  locale: co.includes(e.locale) ? e.locale : Za     (Za="en-US")
  //                e.locale 是 useIntl().locale，也就是 zh-TW。原版靠這道判斷把
  //                任何伺服器不認得的碼降級成 en-US；我們把 zh-TW 塞進陣列，
  //                等於把這道判斷拆了 ⇒ POST .../completion 帶 locale:"zh-TW"
  //                ⇒ 伺服器 422：locale: Input should be 'en-US', 'de-DE', …
  //                （伺服器那份清單和本陣列**原版**逐字相同，連順序都一樣。）
  //     shared-4   `LU()` 幫外部說明連結加 ?language=xx；switch 沒有 zh-TW 分支，
  //                default 回傳字串而不是二元組，被解構成 ?z=h。看不到 zh-TW
  //                反而會走 `return e`（原樣不動），比較正確。
  //
  // 所以修法不是「別加 zh-TW」（那樣選單就沒有這一列、開機也協商不到），也不是
  // 在送出的路上再攔一次改 body（onBeforeRequest 根本改不了 body，而且在關鍵
  // 路徑上加常駐改寫器正是先前黑畫面的來源）。修法是把「我們自己加進去的那一
  // 個碼」在**它自己身上**標成「只供列舉、不算伺服器成員」：陣列照樣含 zh-TW
  // （迭代、展開、map、length 全部不變），但它自己的 includes 對這個碼回 false。
  // 這是對我們注入的那個值下定義，不是在別人的資料流上加過濾器；zh-TW 只存在
  // 於這台機器，「伺服器不認得它」本來就是它的事實屬性。
  //
  // 不動 Array.prototype——只在這一個陣列上定義自有屬性（non-enumerable），
  // JSON.stringify / Object.keys / for…in / [...a] 全部維持原樣。
  const ZHTW_MARK = '/*zhtw-ui-only*/';
  const buildLocaleArrayExpr = (arrLit, code) => {
    const q = JSON.stringify(code);
    const withCode = arrLit.replace('"en-US",', '"en-US",' + q + ',');
    return '(function(){var a=' + withCode
         + ';Object.defineProperty(a,"includes",{value:function(v){return v!==' + q
         + '&&Array.prototype.includes.apply(this,arguments)},writable:true,configurable:true});'
         + 'return a})()' + ZHTW_MARK;
  };

  // 改寫失敗原因（給呼叫端記 log 用）。刻意不在本區塊裡呼叫 log —— PURE 區段
  // 會被測試工具原文抽出後單獨求值，不能依賴外面的東西。
  let patchChunkWhy = '';

  // 功能性後置驗證：真的把改寫後的初始化式跑一次，證明「列舉得到、成員判定看
  // 不到」同時成立。形狀比對只能證明字串長得對，這一步才證明語意對。
  const verifyLocaleArrayExpr = (expr, code, want) => {
    let a;
    try { a = new Function('return (' + expr + ');')(); }
    catch (e) { return '初始化式求值失敗: ' + ((e && e.message) || e); }
    if (!Array.isArray(a)) return '不是陣列';
    if (a.length !== want) return '長度 ' + a.length + '，預期 ' + want;
    if (Array.from(a).indexOf(code) < 0) return '迭代不到 ' + code;
    if (a.indexOf(code) < 0) return 'indexOf 找不到 ' + code;
    if (a.includes(code) !== false) return 'includes("' + code + '") 仍是 true';
    if (a.includes('en-US') !== true) return 'includes("en-US") 不是 true';
    if (JSON.parse(JSON.stringify(a)).indexOf(code) < 0) return 'JSON 序列化掉了 ' + code;
    return null;
  };

  const patchLocaleWhitelist = (src, code) => {
    LOCALE_ARR_RE.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = LOCALE_ARR_RE.exec(src))) {
      if (m[0].indexOf('"' + code + '"') >= 0) { patchChunkWhy = '已含 ' + code + '（冪等）'; return null; }
      hits.push(m);
    }
    if (hits.length !== 1) { patchChunkWhy = '白名單命中 ' + hits.length + ' 筆（需恰好 1）'; return null; }
    const h = hits[0];
    const before = h[0].split('","').length;                  // 原本幾個 locale
    const expr = buildLocaleArrayExpr(h[0], code);
    const why = verifyLocaleArrayExpr(expr, code, before + 1);
    if (why) { patchChunkWhy = '改寫後語意驗證不過：' + why; return null; }
    return src.slice(0, h.index) + expr + src.slice(h.index + h[0].length);
  };

  // ── 相對 specifier 絕對化 ────────────────────────────────────────────
  // 只動 ./ 與 ../ 開頭的字面量，且要求關鍵字前一個字元不是識別字字元、也不是
  // 引號（否則 `if("import"!==e)` 這種會被誤判成 import 語句）。
  // 涵蓋：import … from"./x"、import"./x"、export … from"./x"、import("./x")。
  const SPEC = '(\\.{1,2}\\/[^"\'\\n\\\\]*)';
  const PRE = '(^|[^\\w$."\'`\\/])';
  const RX_FROM = new RegExp(PRE + '(from)(\\s*)(["\'])' + SPEC + '\\4', 'g');
  const RX_IMPORT_DYN = new RegExp(PRE + '(import)(\\s*\\(\\s*)(["\'])' + SPEC + '\\4', 'g');
  const RX_IMPORT_BARE = new RegExp(PRE + '(import)(\\s*)(["\'])' + SPEC + '\\4', 'g');
  const RX_META_URL = /import\.meta\.url/g;
  // import.meta 除了 .url 以外的用法（例如 import.meta.resolve）我們無法安全
  // 模擬 —— 一律放棄改寫這支 chunk。
  const RX_META_OTHER = /import\.meta(?!\.url\b)/;

  const absolutizeSpecifiers = (src, base) => {
    let n = 0, bad = 0;
    const sub = (whole, pre, kw, mid, q, spec) => {
      let abs;
      try { abs = new URL(spec, base).href; } catch (e) { abs = null; }
      if (!abs || abs.indexOf('"') >= 0 || abs.indexOf('\n') >= 0) { bad++; return whole; }
      n++;
      return pre + kw + mid + q + abs + q;
    };
    let out = src.replace(RX_FROM, sub);
    out = out.replace(RX_IMPORT_DYN, sub);
    out = out.replace(RX_IMPORT_BARE, sub);
    return { out: out, n: n, bad: bad };
  };

  // 回傳改寫後的原始碼；任何一個條件不成立就回 null（= 不改寫、原樣放行）。
  const patchChunk = (src, url, code) => {
    patchChunkWhy = '';
    if (typeof src !== 'string' || src.length < 64) { patchChunkWhy = 'body 太短'; return null; }
    const withLocale = patchLocaleWhitelist(src, code);
    if (withLocale === null) return null;                 // 不是那支 chunk（原因已記在 patchChunkWhy）
    if (RX_META_OTHER.test(withLocale)) { patchChunkWhy = '有 import.meta.url 以外的 import.meta'; return null; }
    const r = absolutizeSpecifiers(withLocale, url);
    if (r.bad) { patchChunkWhy = r.bad + ' 個 specifier 解不開'; return null; }
    let out = r.out.replace(RX_META_URL, JSON.stringify(url));
    // 結構驗證：改寫後不得殘留任何相對 specifier，且白名單必須恰好命中一次且含新碼。
    RX_FROM.lastIndex = 0; RX_IMPORT_DYN.lastIndex = 0; RX_IMPORT_BARE.lastIndex = 0;
    if (RX_FROM.test(out) || RX_IMPORT_DYN.test(out) || RX_IMPORT_BARE.test(out)) { patchChunkWhy = '仍有相對 specifier'; return null; }
    LOCALE_ARR_RE.lastIndex = 0;
    const after = out.match(LOCALE_ARR_RE) || [];
    if (after.length !== 1 || after[0].indexOf('"' + code + '"') < 0) { patchChunkWhy = '改寫後白名單形狀不對'; return null; }
    // 只供列舉的標記必須恰好一份。多一份代表誤中別的陣列，少一份代表上面那段
    // 改寫沒真的落到輸出裡 —— 兩種都不能供應出去。
    if (out.split(ZHTW_MARK).length - 1 !== 1) { patchChunkWhy = ZHTW_MARK + ' 標記不是恰好 1 份'; return null; }
    if (out.indexOf('import.meta.url') >= 0) { patchChunkWhy = '仍有 import.meta.url'; return null; }
    return out;
  };

  // ── zhtw:// 鏡像 URL ────────────────────────────────────────────────
  // 形狀與原 URL 逐段對齊（只換 scheme），這樣即使有我們沒改到的相對解析，
  // 也還能落回 handler 由它 302 導回原站，而不是 404。
  //
  // 但 host 部分**不可信**：Chromium 對自訂 standard scheme 沒有預設連接埠，
  // 會把 `zhtw://127.0.0.1:45312/x` 正規化成 `zhtw://127.0.0.1/x`（實測，
  // harness urlprobe）。所以原始 URL 一律另外以 query 參數原樣夾帶 —— query
  // 逐位元保留。host/path 只當作「相對解析的提示」，不是還原來源。
  const MIRROR_SKIP = { res: 1, boot: 1 };
  const MIRROR_Q = '__zhtw';
  const toMirror = (u) => {
    try {
      const o = new URL(u);
      if (o.protocol !== 'https:' || MIRROR_SKIP[o.hostname]) return null;
      return 'zhtw://' + o.host + o.pathname + '?' + MIRROR_Q + '=' + encodeURIComponent(u);
    } catch (e) { return null; }
  };
  const fromMirror = (u) => {
    try {
      const o = new URL(u);
      if (o.protocol !== 'zhtw:' || MIRROR_SKIP[o.hostname]) return null;
      const exact = o.searchParams.get(MIRROR_Q);
      if (exact && exact.lastIndexOf('https://', 0) === 0) return exact;
      return 'https://' + o.host + o.pathname;   // 提示還原（連接埠可能已遺失）
    } catch (e) { return null; }
  };

  const ASSET_JS = /\/assets\/v\d+\/[^/]+\.m?js$/;
  const BOOT_RE = /\/edge-api\/bootstrap(\/|\?|$)/;

  // 「含 locale 白名單的那一支 chunk」的 URL 形狀（證據見檔頭）。
  // 只比對 pathname，不綁 host：既有的 ASSET_JS / discovery 也都不綁 host，
  // 綁上去只會在 Anthropic 換 assets 網域時多一種靜默失效，卻擋不掉任何實際
  // 風險 —— 這個路徑形狀本來就是該 bundler 的產物。
  // 觀察到的雜湊都是 8 個 base64url 字元（DjvNCUSW / CGsBZhm2 / BfUvjjvm /
  // 8TRRKqAc，bundle 內另有 DfpHmf5- / D-GQzpRG / qOVsws_h），故字集取
  // [A-Za-z0-9_-]，長度放寬到 4..32。
  // 編號不可寫死：Anthropic 在 1.37937.3 把白名單從 shared-2 搬到 shared-3，
  // 就地探測因此撲空、退回英文（背景掃描仍找得到，但要等下次啟動）。
  // 尾端連字號仍是關鍵：shared-20-… 之類不會被誤中。
  // 名稱段也不可寫死：1.44121.4 當下線上把白名單從 shared-3 改名成
  // shared-common-3，只認 shared-<數字> 的舊式樣因此撲空，那次啟動退回英文
  // （boot.log 03:10:55 ZHTW-INLINE-MISS -> 03:10:56 ZHTW-DISCOVERED，下次啟動才生效）。
  // 中間那段限定小寫字母且編號仍必須存在，所以 shared-frame-<hash>.js 不會被誤中。
  const CHUNK_RE = /\/assets\/v\d+\/shared-(?:[a-z]+-)?\d+-[A-Za-z0-9_-]{4,32}\.m?js$/;

  // ══════════════════════════════════════════════════════════════════════
  // <<< PURE-END
  // ══════════════════════════════════════════════════════════════════════

  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  // (1) 合併式 registerSchemesAsPrivileged
  try {
    const orig = protocol.registerSchemesAsPrivileged.bind(protocol);
    let merged = [MINE];
    protocol.registerSchemesAsPrivileged = (list) => {
      const seen = new Set(merged.map((x) => x.scheme));
      for (const s of (list || [])) if (s && !seen.has(s.scheme)) { merged.push(s); seen.add(s.scheme); }
      log('registerSchemes 合併 -> ' + merged.map((x) => x.scheme).join(','));
      return orig(merged);
    };
    orig(merged);
    log('scheme 已註冊（合併版）');
  } catch (e) { log('scheme 包裹失敗: ' + e.message); }

  const MAP = [
    ['/i18n/' + LOC + '.overrides.json', 'overrides.json'],
    ['/i18n/dynamic/' + LOC + '.json', 'dynamic.json'],
    ['/i18n/' + LOC + '.json', 'main.json'],
  ];
  const RES_OK = new Set(MAP.map((x) => x[1]));

  // ── 已驗證的改寫結果（磁碟快取）───────────────────────────────────────
  // URL 內含內容雜湊 ⇒ 不可變 ⇒ 用 URL 當 key 天生正確；Claude 換版 ⇒ URL 變 ⇒
  // 快取自然失效，discovery 會重跑。
  let hitUrl = null;
  let hitBody = null;
  // 記住上次命中的「族號」（shared-3-XXXX.js 的 3）。換 build 時雜湊會變、
  // 族號通常不變 —— 觀察到的七個 build 裡只搬過一次家。有族號就只探那一族：
  // 所有 chunk 幾乎同時被請求而同時只准壓住一支，不挑族號就會把名額花在最先
  // 到達的 shared-0 上，永遠探錯、退回英文。
  let lastFamily = null;
  // 族號含名稱段：'common-3' 與 '3' 必須是不同的族，否則兩者會互相誤配。
  const FAM_RE = /\/shared-((?:[a-z]+-)?\d+)-[A-Za-z0-9_-]+\.m?js$/;
  const famOf = (u) => { const m = FAM_RE.exec(u); return m ? m[1] : null; };
  try {
    const meta = JSON.parse(fs.readFileSync(CACHE_META, 'utf8'));
    if (meta && meta.pv !== PATCH_VERSION) {
      log('改寫快取是舊版改寫語意（pv=' + JSON.stringify(meta.pv) + '，本版 ' + PATCH_VERSION
        + '），忽略並重新探測');
    } else if (meta && meta.locale === LOC && typeof meta.url === 'string' && typeof meta.sha === 'string') {
      const fam = FAM_RE.exec(meta.url);
      if (fam) lastFamily = fam[1];
      const b = fs.readFileSync(CACHE_BODY, 'utf8');
      if (sha(b) === meta.sha) { hitUrl = meta.url; hitBody = b; }
      else log('!! 改寫快取雜湊不符，忽略');
    }
  } catch (e) { /* 沒有快取是正常的（第一次安裝 / Claude 剛更新） */ }

  // ── 自我解除計數器 ──────────────────────────────────────────────────
  // 「改寫真的上了場、頁面真的起跑了、然後畫面壞掉」連續 DISARM_AT 次
  // ⇒ 自我停用所有改寫，並把停用狀態寫進 health.json 直到被明確解除。
  //
  // 計數的觸發點**不是**「啟動之後沒等到健康心跳」。那個舊條件用的是牆鐘沉默，
  // 而啟動可能整段卡在視窗還沒出來的地方 —— 鑰匙圈授權對話框就是這樣：它在
  // 頁面開始載入之前擋住整個啟動，使用者慢一點回答（或乾脆不回答）看起來就和
  // 「改寫把畫面弄壞了」一模一樣。實測誤判（本機 boot.log，UTC）：
  //   06:26:48 ZHTW-BOOT armed=1 cached=0 fail=0
  //   06:28:39 ZHTW-BOOT armed=1 cached=1 fail=1
  //   07:29:50 ZHTW-BOOT armed=1 cached=1 fail=2
  //   07:30:09 ZHTW-BOOT armed=0 cached=1 fail=0   <- 沒有任何東西壞掉卻自我停用
  // 這幾次啟動都伴隨鑰匙圈授權對話框（system log 同一秒有 SecurityAgent
  // 「SC confirmation dialog detected」），畫面根本還沒開始載入。
  //
  // 所以計數改掛在唯一有證據的兩個點上，兩者都代表「頁面起跑後失敗」：
  //   1. doHeal() —— 自我修復真的動手：UI webContents 已回報自己在 https、
  //      確實吃到我們的改寫、複測仍然不健康；
  //   2. ZHTW-SCRIPTFAIL —— renderer 直說我們改過的資源載入失敗。
  // 從未開始載入的啟動不留下任何計數。注意這不是把窗口拉長 —— 窗口
  // （HEAL_WINDOW_MS）本來就從「UI 回報自己在 https」才起算，一次都沒起錶的
  // 啟動連窗口都不存在，自然也不該有計數。
  const DISARM_AT = 2;
  let health = { fail: 0 };
  try { health = JSON.parse(fs.readFileSync(HEALTH_F, 'utf8')) || { fail: 0 }; } catch (e) {}
  if (!health || typeof health !== 'object') health = { fail: 0 };
  const saveHealth = () => { try { fs.writeFileSync(HEALTH_F, JSON.stringify(health)); } catch (e) {} };
  let armed = true;
  // 一次啟動最多記一次。前置條件是 rewroteSomething —— 這次啟動確實送出過至少
  // 一份改寫過的 body。沒送出過改寫，畫面再怎麼壞都不可能是我們造成的。
  let failCounted = false;
  const bumpFail = (why) => {
    if (failCounted) return;
    // 刻意不看 armed：doHeal() 會先 hardDisarm() 再回來記帳，若在這裡擋掉
    // !armed，真正壞掉的那一次就永遠記不進去。
    if (!rewroteSomething) return;
    failCounted = true;
    health.fail = (health.fail | 0) + 1;
    health.lastFail = { at: new Date().toISOString(), why: String(why || '') };
    saveHealth();
    log('ZHTW-FAILCOUNT fail=' + (health.fail | 0) + '/' + DISARM_AT + ' 原因：' + why);
  };
  if (health.disarmed) {
    armed = false;
    log('ZHTW-DISARM 先前已自我停用（' + (health.at || '?') + '：' + (health.why || '?')
      + '）。本次啟動不改寫任何東西，App 會是英文但完全可用。'
      + '要重新啟用：patch-claude rearm');
  } else if ((health.fail | 0) >= DISARM_AT) {
    armed = false;
    health.disarmed = true;
    health.at = new Date().toISOString();
    health.why = '連續 ' + DISARM_AT + ' 次「頁面起跑後畫面不健康」';
    saveHealth();
    log('ZHTW-DISARM ' + health.why + ' ⇒ 自我停用所有改寫'
      + '（App 會是英文但完全可用）。要重新啟用：patch-claude rearm');
  }
  log('ZHTW-BOOT locale=' + LOC + ' armed=' + (armed ? 1 : 0)
    + ' cached=' + (hitUrl ? 1 : 0) + ' fail=' + (health.fail | 0)
    + ' disarmed=' + (health.disarmed ? 1 : 0));

  // ── 防迴圈令牌 ──────────────────────────────────────────────────────
  // 主行程自己發出的 ses.fetch 會再經過 onBeforeRequest。發出前先 markSelf，
  // 監聽器 takeSelf 命中就跳過我們自己的所有重導邏輯（但仍串接 App 的監聽器）。
  const selfTok = new Map();
  const markSelf = (u, ms) => {
    const a = selfTok.get(u) || [];
    a.push(Date.now() + (ms || 60000));
    selfTok.set(u, a);
  };
  const takeSelf = (u) => {
    const a = selfTok.get(u);
    if (!a) return false;
    const now = Date.now();
    while (a.length && a[0] < now) a.shift();
    if (!a.length) { selfTok.delete(u); return false; }
    a.shift();
    if (!a.length) selfTok.delete(u);
    return true;
  };

  // ── gated_messages 對照表（英文原字串 -> 繁體中文）───────────────────
  let gmCache = { mtime: 0, map: null };
  const loadMap = () => {
    const p = path.join(dir, 'gated.json');
    try {
      const st = fs.statSync(p);
      if (gmCache.map && gmCache.mtime === st.mtimeMs) return gmCache.map;
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      delete m._comment;
      gmCache = { mtime: st.mtimeMs, map: m };
      return m;
    } catch (e) { return gmCache.map || {}; }
  };

  // bootstrap 的 gated_messages 會蓋過我們供應的 catalog。這些 secret:* key 與
  // 公開 catalog 零重疊，而且**沒有編譯進去的英文 defaultMessage**（字面上是一個
  // 半形空格）—— 所以必須讓 merge 條件成立（locale 對齊），否則 4000 多處會渲染
  // 成空白、側欄項目會被 filter 掉、gates 會被清空（findings §2.2）。
  const rewriteBootstrapBody = (body) => {
    const j = JSON.parse(body);
    if (typeof j.locale === 'string') j.locale = LOC;
    const gm = j && j.gated_messages;
    if (!gm || !gm.messages) { log('bootstrap: 無 gated_messages，只改寫 locale'); return JSON.stringify(j); }
    const from = gm.locale;
    gm.locale = LOC;
    const map = loadMap();
    let n = 0, total = 0;
    const pending = {};
    for (const k of Object.keys(gm.messages)) {
      const v = gm.messages[k];
      if (typeof v !== 'string') continue;
      total++;
      if (map[v]) { gm.messages[k] = map[v]; n++; } else if (v.trim()) pending[v] = k;
    }
    log('ZHTW-BOOTSTRAP 改寫: ' + n + '/' + total + ' 條譯出，伺服器 locale=' + from + ' -> ' + LOC);
    if (from && !/^en([-_]|$)/i.test(String(from))) {
      log('!! 警告：伺服器送來的 gated_messages 不是英文（' + from + '）。'
        + '請在語言選單選一次 English (United States) 再重啟，否則未譯字串會是該語言。');
    }
    try { fs.writeFileSync(PENDING_F, JSON.stringify(pending, null, 1)); } catch (e) {}
    return JSON.stringify(j);
  };

  // ── discovery：找出「含 locale 白名單」的那一支 chunk ────────────────
  // 完全在背景跑，永遠不阻塞任何請求。找到之後寫進磁碟快取，**下一次啟動**生效。
  // 這是刻意的取捨：寧可第一次啟動是英文，也不要為了搶這一次而讓 chunk 請求
  // 卡在我們的網路往返上。安裝器會自己跑兩輪啟動把這一步吃掉。
  const PROBE_MAX = 400;          // 最多探測幾支 chunk
  const PROBE_CONC = 2;
  const STALE_AT = 12;            // 看過這麼多支 asset JS 都不是快取那支 ⇒ 判定快取過期
  const probeSeen = new Set();
  const probeQ = [];
  const deferQ = [];              // 有快取時先擱著，確認快取過期才送去探測
  let probeRunning = 0;
  let probeDone = 0;
  let probeStopped = false;
  let hitRequested = false;       // 快取那支這次真的被請求過嗎
  let assetSeen = 0;

  const saveHit = (url, body) => {
    try {
      const tmpB = CACHE_BODY + '.tmp';
      fs.writeFileSync(tmpB, body, 'utf8');
      fs.renameSync(tmpB, CACHE_BODY);
      const tmpM = CACHE_META + '.tmp';
      fs.writeFileSync(tmpM, JSON.stringify({ locale: LOC, pv: PATCH_VERSION, url: url, sha: sha(body), at: new Date().toISOString() }), 'utf8');
      fs.renameSync(tmpM, CACHE_META);
      return true;
    } catch (e) { log('改寫快取寫入失敗: ' + e.message); return false; }
  };

  const probeOne = async (ses, url) => {
    markSelf(url);
    let r;
    try {
      r = await ses.fetch(url, { method: 'GET', bypassCustomProtocolHandlers: true });
    } catch (e) { takeSelf(url); return; }
    if (!r.ok) return;
    const ct = r.headers.get('content-type') || '';
    if (!/javascript|ecmascript/i.test(ct)) return;
    let src;
    try { src = await r.text(); } catch (e) { return; }
    let out = null;
    try { out = patchChunk(src, url, LOC); } catch (e) { log('patchChunk 例外: ' + e.message); return; }
    if (out === null) { log('discovery 略過（' + patchChunkWhy + '）: ' + url.slice(0, 100)); return; }
    // 這支 probe 是在 await 之前排出去的，期間可能已經硬性解除。
    // hardDisarm 清得掉佇列，清不掉在途的抓取，所以這裡要再確認一次。
    if (hardDisarmed) { log('probe 完成但改寫已硬性解除，丟棄結果: ' + url.slice(0, 100)); return; }
    hitUrl = url;
    hitBody = out;
    const ok = saveHit(url, out);
    probeStopped = true;
    probeQ.length = 0;
    log('ZHTW-DISCOVERED url=' + url + ' bytes=' + out.length + ' cached=' + (ok ? 1 : 0)
      + '（下次啟動生效）');
  };

  const pump = (ses) => {
    while (!probeStopped && probeRunning < PROBE_CONC && probeQ.length) {
      const u = probeQ.shift();
      probeRunning++;
      probeDone++;
      probeOne(ses, u)
        .catch((e) => log('probe 例外: ' + (e && e.message)))
        .then(() => { probeRunning--; setTimeout(() => pump(ses), 0); });
    }
  };

  // 有效快取 ⇒ 不探測（穩態，零成本）。
  // 沒有快取 ⇒ 立刻探測（全新安裝）。
  // 有快取但看過 STALE_AT 支 asset JS 都不是它 ⇒ Claude 換版了，快取過期，開始探測。
  // 沒有這一條的話，過期快取會讓 discovery 永遠不再啟動（harness F_stale 抓到）。
  const enqueueProbe = (ses, url) => {
    if (probeStopped || hitRequested || probeSeen.has(url)) return;
    if (probeDone + probeQ.length + deferQ.length >= PROBE_MAX) return;
    probeSeen.add(url);
    if (hitUrl && assetSeen < STALE_AT) { deferQ.push(url); return; }
    if (deferQ.length) {
      if (hitUrl) log('!! 改寫快取疑似過期（已看過 ' + assetSeen + ' 支 asset JS 都不是它）'
        + '，重新啟動 discovery: ' + hitUrl);
      while (deferQ.length) probeQ.push(deferQ.shift());
    }
    probeQ.push(url);
    pump(ses);
  };

  // ── 就地探測（Part 1）：同一次啟動就把白名單改寫套上去 ────────────────
  // 候選集合每次啟動只有 1 個 URL（見檔頭），所以「壓住回呼、自己抓一次、
  // 改寫、重導」的成本是一支檔案多抓一次，而且只在還沒有驗證過的改寫結果
  // 時才發生。穩態（磁碟快取命中）完全不走這條路，零延遲。
  //
  // 逾時取 5 秒。理由：這支 chunk 實測 370–450 KB，就算在 1 Mbps 的爛線路上
  // 也只要約 3.2 秒，5 秒對「慢但能用」的網路仍有餘裕；而它同時是本 shim 能
  // 對頁面造成的延遲上限，每次啟動最多發生一次（失敗會記進 inlineTried，
  // 之後同一支 URL 直接放行）。相對於 boot.log 實測的健康載入時間（啟動到
  // ZHTW-HEALTHY 最慢 19.8 秒）只佔四分之一，不會把頁面推過自我修復的窗口。
  const INLINE_TIMEOUT = 5000;
  // 每次啟動最多壓住一個請求。形狀比對不綁 host，理論上一次啟動可能撞到不只
  // 一個符合形狀的 URL；沒有這個上限的話，逾時代價會逐一累加到頁面上。
  const INLINE_MAX_HOLDS = 1;
  let inlineHolds = 0;
  // 嘗試次數必須與「同時壓住數」分開。inlineHolds 只增不減，等於「每次啟動
  // 只准探測一次」—— 1.37937.3 把白名單從 shared-2 搬到 shared-3，先到的
  // shared-2 探空就吃掉唯一名額，shared-3 再也沒機會，整次啟動退回英文。
  // 正確語意是「成功改寫一次就停」：失敗交還名額，另用次數上限防止無限探。
  const INLINE_MAX_TRIES = 6;
  let inlineTries = 0;
  const inlineTried = new Set();      // 這次啟動已就地探測過（不論成敗）的 URL

  // 一定 resolve，永不 reject。回傳
  //   { ok:true, out }                       改寫成功
  //   { ok:false, why, shape:true }          內容確定不是白名單那支（結論）
  //   { ok:false, why }                      意外失敗（逾時／網路／狀態碼…）
  const inlineProbe = (ses, url) => {
    let ctl = null;
    try { ctl = new AbortController(); } catch (e) { ctl = null; }

    const work = (async () => {
      // 我們自己發出的請求會再經過 onBeforeRequest —— 用既有的 markSelf/
      // takeSelf 令牌跳過本 shim 的重導，否則無限遞迴。令牌壽命綁在逾時上，
      // 不用預設的 60 秒，免得逾時後還殘留很久。
      markSelf(url, INLINE_TIMEOUT + 2000);
      const opt = { method: 'GET', bypassCustomProtocolHandlers: true };
      if (ctl) opt.signal = ctl.signal;
      let r;
      try { r = await ses.fetch(url, opt); }
      catch (e) { takeSelf(url); return { ok: false, why: '抓取失敗: ' + ((e && e.message) || e) }; }
      if (!r.ok) return { ok: false, why: '非 2xx: ' + r.status };
      const ct = r.headers.get('content-type') || '';
      if (!/javascript|ecmascript/i.test(ct)) return { ok: false, why: '非 JS: ' + ct };
      let src;
      try { src = await r.text(); } catch (e) { return { ok: false, why: '讀取 body 失敗' }; }
      let out;
      try { out = patchChunk(src, url, LOC); }
      catch (e) { return { ok: false, why: 'patchChunk 例外: ' + ((e && e.message) || e) }; }
      // patchChunk 已經涵蓋：不是那支 chunk、import.meta 形狀不對、相對
      // specifier 解不開、改寫後結構驗證不過 —— 一律 null。這是對「內容」下的
      // 結論，所以標記 shape:true：背景 discovery 不必再抓同一個 URL。
      if (out === null) return { ok: false, shape: true, why: 'patchChunk 放棄（' + patchChunkWhy + '）' };
      return { ok: true, out: out };
    })();

    let timer = null;
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        try { if (ctl) ctl.abort(); } catch (e) {}
        // 收回自己的防迴圈令牌。正常情況下我們的 ses.fetch 會再經過
        // onBeforeRequest 並把它用掉，但中止掉的請求可能永遠不會走到那裡，
        // 令牌就會留下來，把之後 renderer 對同一支 URL 的請求誤判成「我們自己
        // 發的」而整段跳過 —— 連交還給背景 discovery 的重試都會被吃掉。
        takeSelf(url);
        resolve({ ok: false, why: '逾時 ' + INLINE_TIMEOUT + 'ms' });
      }, INLINE_TIMEOUT);
      work.then(resolve, (e) => resolve({ ok: false, why: (e && e.message) || String(e) }));
    }).then((res) => {
      if (timer) { clearTimeout(timer); timer = null; }
      return res;
    });
  };

  // ── 硬性解除 + 改寫歸屬（Part 2 的前置）───────────────────────────────
  // armed=false 只擋 bootstrap 與 chunk，擋不掉 i18n 重導（那段在 armed 檢查
  // 之前）。自我修復要的是「往後什麼都不改」，所以另立一個旗標，放在監聽器
  // 最前面，並且在 zhtw handler 裡也擋一次 —— 重載絕不能再拿到改寫過的 body。
  let hardDisarmed = false;
  const hardDisarm = (why) => {
    if (hardDisarmed) return;
    hardDisarmed = true;
    armed = false;
    hitBody = null;          // handler 就算被呼叫也拿不出改寫結果
    probeStopped = true;
    probeQ.length = 0;
    deferQ.length = 0;
    log('ZHTW-HARDDISARM ' + why + ' — 本行程往後不再改寫任何請求');
  };

  // 自我修復只對「真的吃到我們改寫結果的那個 webContents」動手。
  // onBeforeRequest 的 details 帶 webContentsId，這是最直接的歸屬證據。
  // 萬一該欄位不存在，rewriteWcId 維持 0，退回用心跳回報的 location.href 是否
  // 為 https 來認 UI —— boot.log 實測外殼視窗停在 file://…/index.html、輔助
  // 視窗停在 about:blank，兩者都不會被誤認成 UI。
  let rewroteSomething = false;
  const rewriteWcIds = new Set();
  // 集合，不是單一指標。之前寫成「最後一次覆蓋」，結果只要有第二個視窗事後拿了
  // 任何一支改寫（例如 about 視窗抓 i18n catalog），指標就被搬走，真正黑掉的那個
  // 視窗反而被判定「不是吃到改寫的那個」而永遠不會被修復（實測 heal.js 重現）。
  const noteRewriteTarget = (d) => {
    const id = d && d.webContentsId;
    if (typeof id === 'number' && id > 0) rewriteWcIds.add(id);
  };

  // 我們動過手腳的 URL 檔名集合。renderer 若為其中任何一支報出模組載入失敗，
  // 就是「改壞了」的直接證據 —— 安裝器據此硬性回滾。
  const touched = new Set();
  const baseName = (u) => String(u).split('?')[0].split('/').pop();
  const noteTouched = (u) => { try { if (u) touched.add(baseName(u)); } catch (e) {} };

  // 重導到 zhtw:// 之後，原本同源的請求變成跨源，因此回應必須自己過 CORS。
  // 有 Origin 就照抄並附上 allow-credentials —— 這樣 credentials:'include' 與
  // 'same-origin'/'omit' 三種模式都成立（回 '*' 只有前者會被瀏覽器拒絕）。
  const CORS = (req) => {
    const h = { 'cross-origin-resource-policy': 'cross-origin' };
    let o = null;
    try { o = req.headers.get('origin'); } catch (e) {}
    if (o) {
      h['access-control-allow-origin'] = o;
      h['access-control-allow-credentials'] = 'true';
      h['vary'] = 'Origin';
    } else h['access-control-allow-origin'] = '*';
    return h;
  };

  const arm = (ses, tag) => {
    try {
      if (!ses || ses.__zhtw) return;
      ses.__zhtw = true;

      // ── zhtw:// handler ────────────────────────────────────────────
      //   zhtw://res/<file>     本機 i18n catalog（沿用既有機制）
      //   zhtw://boot/?u=<url>  bootstrap 改寫
      //   zhtw://<host>/<path>  被改寫的 chunk（其餘一律 302 導回原站）
      try {
        ses.protocol.handle('zhtw', async (req) => {
          let uo;
          try { uo = new URL(req.url); } catch (e) { return new Response(null, { status: 400 }); }
          const host = uo.hostname;

          // 自我修復已經解除全部改寫：即使還有在途的 zhtw:// 請求落進來，也
          // 一律導回原站，絕不再供應任何改寫過的 bytes。
          if (hardDisarmed) {
            let back = null;
            try {
              back = (host === 'boot' || host === 'res') ? uo.searchParams.get('u') : fromMirror(req.url);
            } catch (e) {}
            if (back && /^https:\/\//.test(back)) {
              log('zhtw:// 已硬性解除，302 導回原站: ' + back.slice(0, 120));
              markSelf(back);
              return new Response(null, { status: 302, headers: Object.assign({ location: back }, CORS(req)) });
            }
            return new Response(null, { status: 404 });
          }

          if (host === 'res') {
            // 白名單，不用 URL 拼路徑：這個 handler 從 renderer 就摸得到。
            const n = uo.pathname.replace(/^\/+/, '') || 'main.json';
            if (!RES_OK.has(n)) { log('zhtw://res 檔名不在白名單，拒絕: ' + n); return new Response(null, { status: 404 }); }
            log('zhtw:// 供應 ' + n + ' [' + tag + ']');
            rewroteSomething = true;
            return new Response(fs.readFileSync(path.join(dir, n)), {
              status: 200,
              headers: Object.assign({ 'content-type': 'application/json' }, CORS(req)),
            });
          }

          if (host === 'boot') {
            const orig = uo.searchParams.get('u');
            if (!orig || !/^https:\/\//.test(orig)) return new Response(null, { status: 400 });
            // bootstrap 改寫是**承重**的一半，不能單獨失敗。
            // findings §2.2：locale=zh-TW 但 gated_messages.locale 沒對齊時，
            // shared-13 的 merge 條件不成立 ⇒ 4000 多處 secret:* 只剩一個半形
            // 空格、側欄項目被 filter 掉。也就是「只有 chunk 改寫成功」比兩邊
            // 都不改**更糟**。所以 bootstrap 一旦放棄，就立刻連 chunk 改寫一起
            // 解除（本行程往後的頁面載入都退回原版），並留下讓安裝器回滾的標記。
            const bail = (why) => {
              log('ZHTW-BOOTFAIL bootstrap 改寫放棄（' + why + '），302 導回原站；'
                + '同時解除 chunk 改寫，避免 gated 字串變空白');
              armed = false;
              markSelf(orig);
              return new Response(null, { status: 302, headers: Object.assign({ location: orig }, CORS(req)) });
            };
            let r;
            markSelf(orig);
            try {
              r = await ses.fetch(orig, {
                method: 'GET',
                headers: { accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' },
                credentials: 'include',
                cache: 'no-store',
                bypassCustomProtocolHandlers: true,
              });
            } catch (e) { takeSelf(orig); return bail('fetch 失敗: ' + (e && e.message)); }
            if (!r.ok) return bail('非 2xx: ' + r.status);
            const ct = r.headers.get('content-type') || '';
            if (!/json/i.test(ct)) return bail('非 JSON: ' + ct);
            let body;
            try { body = await r.text(); } catch (e) { return bail('讀取 body 失敗'); }
            let out;
            try { out = rewriteBootstrapBody(body); }
            catch (e) { log('bootstrap 解析失敗，原樣供應: ' + e.message); out = body; }
            rewroteSomething = true;
            const h = Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS(req));
            return new Response(out, { status: 200, headers: h });
          }

          // 被改寫的 chunk
          const orig = fromMirror(req.url);
          if (orig && hitBody && orig === hitUrl && armed) {
            log('ZHTW-PATCHED url=' + orig + ' bytes=' + hitBody.length);
            rewroteSomething = true;
            return new Response(hitBody, {
              status: 200,
              headers: Object.assign({
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
              }, CORS(req)),
            });
          }
          // 我們沒改到的相對解析落到這裡：一律 302 導回原站（帶令牌避免再被攔）。
          if (orig) {
            log('zhtw:// 未預期的鏡像請求，302 導回: ' + orig.slice(0, 120));
            noteTouched(orig);
            markSelf(orig);
            return new Response(null, { status: 302, headers: Object.assign({ location: orig }, CORS(req)) });
          }
          return new Response(null, { status: 404 });
        });
        log('zhtw handler 已安裝 [' + tag + ']');
      } catch (e) { log('protocol.handle(zhtw)[' + tag + ']: ' + e.message); }

      // ── (2) 包裹 onBeforeRequest，讓 App 之後的註冊變成串接 ──────────
      const wr = ses.webRequest;
      let appListener = null;
      const origOn = wr.onBeforeRequest.bind(wr);
      origOn({ urls: ['<all_urls>'] }, (d, cbRaw) => {
        // onBeforeRequest 的回呼必須恰好一次。App 自己的監聽器可能先回呼、再丟
        // 例外（實測），那樣就會沿著下面的 catch 再回呼一次 —— 對 Chromium 是
        // 契約違反，而這正是上一版造成黑畫面的同一條路徑。用閂鎖收斂成一次。
        let answered = false;
        const cb = (resp) => {
          if (answered) { log('!! 回呼重複，已忽略: ' + String(d.url).slice(0, 90)); return; }
          answered = true;
          cbRaw(resp);
        };
        const chain = () => {
          if (appListener) {
            try { return appListener(d, cb); } catch (e) { log('app listener 例外: ' + e.message); }
          }
          cb({});
        };
        try {
          const u = d.url;
          if (typeof u !== 'string' || u.lastIndexOf('https://', 0) !== 0) return chain();
          // 自我修復已解除全部改寫（含 i18n）—— 這一條必須在 MAP 之前。
          if (hardDisarmed) return chain();
          // 我們自己發出的請求：跳過本 shim 的所有重導，但仍交給 App 的監聽器。
          if (takeSelf(u)) return chain();

          for (const [needle, file] of MAP) {
            if (u.indexOf(needle) >= 0) {
              log('攔截 ' + file + ' <- ' + u.slice(0, 70));
              noteRewriteTarget(d);
              // 夾帶原始 URL：硬性解除之後，還在途中的請求才有地方可以導回去，
              // 而不是吃一個 404（catalog 404 的失敗形狀比 302 差）。
              return cb({ redirectURL: 'zhtw://res/' + file + '?u=' + encodeURIComponent(u) });
            }
          }

          if (!armed) return chain();

          let p;
          try { p = new URL(u).pathname; } catch (e) { return chain(); }

          if (BOOT_RE.test(p)) {
            if (d.method && d.method !== 'GET') return chain();
            noteRewriteTarget(d);
            return cb({ redirectURL: 'zhtw://boot/?u=' + encodeURIComponent(u) });
          }

          if (ASSET_JS.test(p)) {
            assetSeen++;
            // 穩態：手上已有這支 URL 驗證過的改寫結果（記憶體或磁碟快取），
            // 立刻重導，零額外延遲。絕大多數啟動走的是這條。
            if (hitBody && u === hitUrl) {
              hitRequested = true;
              probeQ.length = 0;
              deferQ.length = 0;
              const m = toMirror(u);
              if (m) { noteTouched(u); noteRewriteTarget(d); return cb({ redirectURL: m }); }
              return chain();
            }

            // 就地探測：**只有**白名單 chunk 的 URL 形狀、而且這次啟動還沒
            // 試過，才會壓住回呼。其餘每一個 URL 都在下面同步 chain()。
            // 非 GET 一律不碰 —— 壓住一個 POST 毫無意義。
            //
            // inlineTried 同時是第二道防迴圈保險，這一點是承重的：markSelf/
            // takeSelf 只認 URL，所以在我們 markSelf 之後、自己的 ses.fetch
            // 回到監聽器之前，若 renderer 又送了一個同 URL 的請求（例如
            // modulepreload 撞上真正的 import），那個請求會把令牌吃掉，我們
            // 自己的 fetch 就會**沒有**令牌地走進監聽器。此時 inlineTried
            // 已經是 true，它會直接落到下面 chain() 出去，不會再被壓住。
            // ⚠ 曾經試過「in-flight 時讓第二個請求併到同一個 promise」，正是
            //    這條路會死鎖：被偷走令牌的自身 fetch 走進來後也被壓住，而它
            //    等的就是自己那個 promise，只能靠逾時解開（實測 harness T8）。
            //    寧可讓重複請求拿到未改寫的原始 bytes（功能沒生效但完全可用），
            //    也不要讓頁面卡住。
            if (CHUNK_RE.test(p)
                && (!d.method || d.method === 'GET')
                && inlineHolds < INLINE_MAX_HOLDS
                && inlineTries < INLINE_MAX_TRIES
                && (!lastFamily || famOf(p) === lastFamily)
                && !inlineTried.has(u)) {
              inlineTried.add(u);
              inlineHolds++; inlineTries++;
              probeSeen.add(u);            // 先擋住背景 discovery；意外失敗時再交還
              const t0 = Date.now();
              log('ZHTW-INLINE 就地探測 ' + u.slice(0, 140));

              let settled = false;
              let guard = null;
              const finish = (fn) => {
                if (settled) return;
                settled = true;
                if (guard) { clearTimeout(guard); guard = null; }
                try { fn(); } catch (e) { log('ZHTW-INLINE 收尾例外: ' + e.message); cb({}); }
              };
              // 安全閥：就算上面的 promise 因為任何理由沒有 settle，請求也一定
              // 會被放掉。壓住的請求永遠不能變成掛死的頁面。
              guard = setTimeout(() => finish(() => {
                log('ZHTW-INLINE-MISS 安全閥逾時 ' + (INLINE_TIMEOUT + 1500) + 'ms ⇒ 原樣放行');
                chain();
              }), INLINE_TIMEOUT + 1500);

              // inlineProbe 的同步例外也必須走 finish，否則它會落到外層的
              // catch 去呼叫 chain()，而安全閥稍後仍會再放一次 —— 同一個請求
              // 的回呼被呼叫兩次。
              try {
              inlineProbe(ses, u).then((res) => finish(() => {
                const ms = Date.now() - t0;
                if (!res.ok) {
                  // 任何失敗都退回原請求：英文、但完整可用。
                  // shape=true 是對內容下的結論（這支確實不含白名單），背景
                  // discovery 不必再抓它。其餘都是意外（逾時／網路／狀態碼），
                  // 必須把 URL 交還背景 discovery —— 否則在慢線路上這一版就
                  // 永遠不會被發現，連「下次啟動生效」都拿不到。
                  if (!res.shape) probeSeen.delete(u);
                  // shape=true 是對內容下的結論：這支 chunk 的 URL 形狀對，但
                  // 裡面沒有 locale 白名單 —— 線上前端改版把它搬走了。這是 (1)，
                  // 不是 (2)：bundle 沒被動過，重簽章對它毫無幫助（見檔頭）。
                  // 記成專屬標籤，好讓 patch-claude status 把「英文是因為遠端
                  // 改版」和「英文是因為 bundle 被官方版換掉」分開講。
                  if (res.shape) {
                    log('ZHTW-REMOTE-SHAPE url=' + u.slice(0, 140)
                      + ' —— 線上前端改版，這支 chunk 已不含 locale 白名單。'
                      + 'bundle 未被更動，重簽章對此無效；本次退回英文，'
                      + '背景 discovery 仍會掃其餘 chunk。');
                  }
                  // 交還名額：這一支不是我們要找的，下一支 shared-N 還有機會。
                  inlineHolds--;
                  log('ZHTW-INLINE-MISS ' + res.why + '（' + ms + 'ms）⇒ 原樣放行'
                    + (res.shape ? '' : '，URL 已交還背景 discovery')
                    + '，剩餘嘗試 ' + (INLINE_MAX_TRIES - inlineTries));
                  return chain();
                }
                // 壓住的這 0~5 秒裡，armed 可能已經被 bootstrap 的 bail() 翻掉，
                // 或 hardDisarmed 已被自我修復拉起。上面那道同步閘門是舊判斷，
                // 這裡必須重驗 —— 否則會做出「chunk 改了但 bootstrap 沒改」這個
                // 本檔開頭就寫明「比兩邊都不改更糟」的狀態。
                if (!armed || hardDisarmed) {
                  log('ZHTW-INLINE-DROP 壓住期間改寫已解除（armed=' + (armed ? 1 : 0)
                    + ' hardDisarmed=' + (hardDisarmed ? 1 : 0) + '）⇒ 原樣放行，且不寫入快取');
                  return chain();
                }
                hitUrl = u;
                hitBody = res.out;
                hitRequested = true;
                probeStopped = true;
                probeQ.length = 0;
                deferQ.length = 0;
                const saved = saveHit(u, res.out);
                const m = toMirror(u);
                log('ZHTW-INLINE-HIT url=' + u + ' bytes=' + res.out.length
                  + ' ' + ms + 'ms cached=' + (saved ? 1 : 0) + '（本次啟動就生效）');
                if (m) { noteTouched(u); noteRewriteTarget(d); return cb({ redirectURL: m }); }
                return chain();
              })).catch((e) => finish(() => {
                log('ZHTW-INLINE-MISS 例外 ' + ((e && e.message) || e) + ' ⇒ 原樣放行');
                chain();
              }));
              } catch (e) {
                finish(() => {
                  log('ZHTW-INLINE-MISS 同步例外 ' + ((e && e.message) || e) + ' ⇒ 原樣放行');
                  chain();
                });
              }
              return;                      // 壓住回呼，等就地探測的結果
            }

            enqueueProbe(ses, u);          // 非阻塞（後備 discovery）
          }
        } catch (e) { log('攔截例外: ' + e.message); }
        return chain();
      });
      wr.onBeforeRequest = (f, l) => {
        appListener = (typeof f === 'function') ? f : l;
        log('App 註冊 onBeforeRequest -> 已串接 [' + tag + ']');
      };
      log('webRequest 已武裝 [' + tag + ']');
    } catch (e) { log('arm[' + tag + '] 失敗: ' + e.message); }
  };

  // ── (5) 舊安裝的 localStorage 遷移 ──────────────────────────────────
  // 舊版補丁把 spa:locale 寫成 id-ID，而 id-ID 仍在白名單裡，不遷移會停在印尼文。
  // 從舊的劫持版升級上來的人需要這一條。
  //
  // 這裡**不再**覆寫 Intl.DisplayNames.prototype.of。曾經有一段覆寫，強迫語言選單
  // 那一列顯示「繁體中文」，移除原因有三：
  //   1. 它會和 App 自己的解析賽跑而且會輸，結果不穩定 —— 同一個 build 連開兩次
  //      分別得到「中文（台灣）/ Chinese (Taiwan)」與「繁體中文 / 繁體中文」。
  //      react-intl 的 formatter 快取是 session 生命週期，而注入發生在頁面載入之後，
  //      誰先誰後決定結果。
  //   2. 就算它贏了也是錯的：它只比對語言碼、不看顯示語系，所以那一列底下的英文
  //      副標也會變成「繁體中文」。選單裡其他每一列都是「原生名 / 英文名」，只有
  //      我們這列同一個字串印兩次。
  //   3. 根本不需要。zh-TW 現在是白名單裡的真成員（不再劫持 id-ID），ICU/CLDR
  //      自己就解析得正確：
  //        new Intl.DisplayNames(['zh-TW'],{type:'language'}).of('zh-TW') -> 中文（台灣）
  //        new Intl.DisplayNames(['en'],   {type:'language'}).of('zh-TW') -> Chinese (Taiwan)
  //      當初寫「仍然必要」的註解是劫持 id-ID 那一版留下來的，已經過期。
  // 順帶把「每次頁面載入都注入一段 patch 全域原型的程式碼」這個對 react-intl 內部
  // 快取行為的依賴一起拿掉 —— Anthropic 前端一改就會壞的耦合。
  const CODE = `(()=>{try{var L=${JSON.stringify(LOC)},R=[];
    try{var s=localStorage.getItem('spa:locale');
        if(s&&s!==L&&/^(id|id-ID)$/i.test(s)){localStorage.setItem('spa:locale',L);R.push('migrated:'+s);}
       }catch(e){}
    return 'migrate-ok '+R.join(',');}catch(e){return 'migrate-err:'+e.message}})()`;

  // ── 心跳 ────────────────────────────────────────────────────────────
  // 安裝器唯一能證明「畫面不是空的」的證據。
  //
  // 只看 innerText.length **不夠**：harness 實測，模組整個載入失敗、SPA 完全
  // 沒掛載的頁面，光靠 index.html 的靜態骨架就能有 67 個字元而被誤判成健康。
  // 所以同時要求「可見元素數」—— 它必須由 SPA 真的渲染出來才會達標
  // （getClientRects().length 會把 display:none / hidden 的骨架排除掉）。
  // 掃描在達標後立刻停手，不會對大型 DOM 造成 layout 負擔。
  const HB_CODE = `(()=>{try{var b=document.body;if(!b)return '{"l":-1,"v":-1}';
    var a=b.querySelectorAll('*'),v=0;
    for(var i=0;i<a.length&&v<30;i++){try{if(a[i].getClientRects().length)v++;}catch(e){}}
    return JSON.stringify({u:location.href,l:(b.innerText||'').length,v:v,r:document.readyState});
  }catch(e){return '{"l":-2,"v":-2}'}})()`;
  const HB_MIN_TEXT = 40;
  const HB_MIN_VIS = 12;
  const HB_EVERY = 1500;
  const HB_MAX = 150;              // 絕對 tick 上限（防呆），實際由 until 這個牆鐘收尾
  // 基本觀察預算維持和舊版一樣的 60 秒（舊版是 HB_MAX=40 × 1500ms）。永遠不會
  // 成為 UI 的 webContents（外殼的 file://、輔助的 about:blank）就只花這些。
  // 只有真的起錶的那一個會把預算延長到蓋過 HEAL_WINDOW_MS —— 否則 heal 收錶時
  // 心跳早就停了，ok 旗標會是過期的。實測一次啟動有 4 個 window 型 webContents，
  // 無條件拉長會讓 boot.log 每次啟動多長約 3 倍。
  const HB_TOTAL_MS = 60000;
  const HB_RECOVER_MS = 45000;     // 自我修復重載之後，再觀察這麼久以留下復原證據
  const HB_ABS_MS = 300000;        // 不論導覽幾次，掛上之後的絕對觀察上限

  // ── 自我修復（Part 2）───────────────────────────────────────────────
  // 真的在跑遠端 UI 的那個 webContents 進入 https 之後，HEAL_WINDOW_MS 內沒有
  // 健康心跳 ⇒ 先解除本行程全部改寫，再 reload 它一次。reload 拿到原始 bytes，
  // 畫面以英文回來，使用者不必手動重開。
  //
  // 窗口取 90 秒。依據 boot.log 實測的健康載入：
  //   19:22:11.597 shim 載入 -> 19:22:31.363 ZHTW-HEALTHY len=4404 vis=30  (19.8s)
  //   19:22:38.654 -> 19:22:53.446 ZHTW-HEALTHY len=4153 vis=30           (14.8s)
  //   19:24:19.862 -> 19:24:33.301 ZHTW-HEALTHY len=4154 vis=30           (13.4s)
  //   03:32:53.169 -> 03:32:56.947 ZHTW-HEALTHY len=1181 vis=30            (3.8s)
  // 最慢的一次整段是 19.8 秒，90 秒約是它的 4.5 倍，足以吸收比實測慢四倍的
  // 線路，外加就地探測最多 5 秒的預算（餘裕 17 倍）。而且起錶點是「UI
  // webContents 第一次回報自己在 https」，不是行程啟動 —— 啟動/認證那段
  // 3.8~19.8 秒的變異最大、卻與我們的改寫無關，整段被排除在預算之外，所以
  // 90 秒實際上比看起來更保守。誤判重載一個健康頁面比慢 90 秒才修復更糟。
  const HEAL_WINDOW_MS = 90000;
  const HEAL_MAX_RELOADS = 1;      // 硬上限：reload 迴圈比黑畫面更糟
  let healReloads = 0;
  let healFired = false;

  const isUiUrl = (s) => typeof s === 'string' && s.lastIndexOf('https://', 0) === 0;

  const watchHeartbeat = (wc) => {
    if (wc.__zhtwHb) { try { wc.__zhtwHb(); } catch (e) {} return; }
    let n = 0, ok = false, timer = null, healTimer = null, anchored = false;
    let attachedAt = Date.now();
    let until = attachedAt + HB_TOTAL_MS;
    // 延長觀察窗，但永遠不超過掛上之後 HB_ABS_MS。心跳的存活時間只影響「能不能
    // 及時起錶」與記錄品質，不影響判斷正確性 —— heal 動手前一定會自己再量一次。
    const extend = (ms) => { until = Math.min(Math.max(until, Date.now() + ms), attachedAt + HB_ABS_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const cancelHeal = () => { if (healTimer) { clearTimeout(healTimer); healTimer = null; } };

    const doHeal = (cur, d) => {
      // 收錶到動手之間隔了一次非同步量測，所以每一道閘門都要重驗一次。
      if (ok || healFired || wc.isDestroyed()) return;
      if (healReloads >= HEAL_MAX_RELOADS) { log('ZHTW-HEAL-SKIP 已達重載硬上限 ' + HEAL_MAX_RELOADS); return; }
      // 先把旗標推上去、再解除，最後才 reload —— 順序不能反：解除必須在
      // reload 發出之前完成，否則重載會再拿到同一份改寫過的 body。
      healFired = true;
      healReloads++;
      // 這裡是「頁面確實起跑後失敗」的第一個證據點：起錶條件是 UI webContents
      // 自己回報在 https，heal() 的三道歸屬檢查已過，而且剛剛才複測過不健康。
      bumpFail('自我修復動手：起錶後 ' + HEAL_WINDOW_MS + 'ms 內畫面仍不健康'
        + '（複測 len=' + d.l + ' vis=' + d.v + '）');
      hardDisarm('載入後 ' + HEAL_WINDOW_MS + 'ms 內沒有健康心跳（複測 len=' + d.l + ' vis=' + d.v + '）');
      // 標籤刻意不叫 ZHTW-HEAL* —— 安裝器用子字串比對，而 "ZHTW-HEALTHY" 本身
      // 就以 "ZHTW-HEAL" 開頭，會把每一次健康心跳都誤判成自我修復。
      log('ZHTW-RELOADED 解除已完成，重載第 ' + healReloads + '/' + HEAL_MAX_RELOADS
        + ' 次 wc=' + wc.id + ' url=' + String(cur).slice(0, 120));
      extend(HB_RECOVER_MS);                // 留下「退回英文之後確實健康」的證據
      try { wc.reload(); } catch (e) { log('ZHTW-HEAL reload 失敗: ' + ((e && e.message) || e)); }
    };

    const heal = () => {
      healTimer = null;
      if (ok || healFired) return;
      if (healReloads >= HEAL_MAX_RELOADS) { log('ZHTW-HEAL-SKIP 已達重載硬上限 ' + HEAL_MAX_RELOADS); return; }
      if (wc.isDestroyed()) return;
      let cur = '';
      try { cur = wc.getURL() || ''; } catch (e) { return; }
      // 三道歸屬檢查，任何一道不過就不動手。
      if (!isUiUrl(cur)) { log('ZHTW-HEAL-SKIP 目標已不在 https（' + String(cur).slice(0, 60) + '）'); return; }
      if (rewriteWcIds.size && !rewriteWcIds.has(wc.id)) {
        log('ZHTW-HEAL-SKIP wc=' + wc.id + ' 沒有吃到任何改寫（吃到的是 wc='
          + Array.from(rewriteWcIds).join(',') + '）'); return;
      }
      if (!rewroteSomething) { log('ZHTW-HEAL-SKIP 這次啟動沒有送出任何改寫，重載沒有意義'); return; }
      // 動手前再量一次，而不是相信可能過期的 ok 旗標。「絕不重載一個其實
      // 已經健康的頁面」是硬性要求，這一次複測就是它的最終依據。
      wc.executeJavaScript(HB_CODE, true).then((s) => {
        let d;
        try { d = JSON.parse(s); } catch (e) { d = { l: -3, v: -3 }; }
        if (d.l >= HB_MIN_TEXT && d.v >= HB_MIN_VIS) {
          ok = true;
          stop();
          log('ZHTW-HEAL-SKIP 收錶前複測是健康的，不重載');
          // 這一版畫面確實是好的，就必須留下 ZHTW-HEALTHY —— 那是安裝器唯一的
          // 通過條件。少了它，一個其實正常的安裝會因為「150 秒內沒有 HEALTHY」
          // 被回滾。
          log('ZHTW-HEALTHY len=' + d.l + ' vis=' + d.v + ' url=' + String(d.u || '').slice(0, 120));
          if (!healFired && rewroteSomething && (health.fail | 0) !== 0) {
            health.fail = 0; saveHealth();
          }
          return;
        }
        doHeal(cur, d);
      }).catch((e) => {
        // 連量都量不到（renderer 沒有回應）本身就是壞掉的證據。
        log('ZHTW-HEAL 複測失敗: ' + ((e && e.message) || e));
        doHeal(cur, { l: -4, v: -4 });
      });
    };

    const tick = () => {
      if (wc.isDestroyed()) return stop();
      if (Date.now() > until) return stop();
      wc.executeJavaScript(HB_CODE, true).then((s) => {
        let d;
        try { d = JSON.parse(s); } catch (e) { d = { l: -3, v: -3 }; }
        log('ZHTW-HEARTBEAT len=' + d.l + ' vis=' + d.v + ' ready=' + d.r
          + ' url=' + String(d.u || '').slice(0, 120));
        // 起錶條件：這個 webContents 自己回報 location.href 是 https。
        // boot.log 實測，外殼視窗停在 file://…/main_window/index.html、輔助
        // 視窗停在 about:blank（len=0 vis=1）—— 兩者都不會走到這裡，所以
        // 既不會被誤重載；而健康狀態本來就是每個 webContents 各自獨立的閉包
        // 變數，about:blank 也不可能替真正的 UI 交出（或推翻）健康判定。
        if (!ok && !anchored && !healFired && isUiUrl(d.u)) {
          anchored = true;             // 每個 webContents 只起一次錶
          // 心跳要活過收錶點，記錄才完整（判斷本身另有複測把關）。
          extend(HEAL_WINDOW_MS + 3 * HB_EVERY);
          log('ZHTW-HEAL-ARM wc=' + wc.id + ' 起錶 ' + HEAL_WINDOW_MS
            + 'ms url=' + String(d.u).slice(0, 120));
          healTimer = setTimeout(heal, HEAL_WINDOW_MS);
        }
        if (!ok && d.l >= HB_MIN_TEXT && d.v >= HB_MIN_VIS) {
          ok = true;
          stop();
          cancelHeal();
          log('ZHTW-HEALTHY len=' + d.l + ' vis=' + d.v + ' url=' + String(d.u || '').slice(0, 120));
          // 自我修復開過火之後不要抹掉失敗紀錄：這次啟動確實壞過，連續兩次
          // 就該讓下一次啟動直接停用改寫（DISARM_AT），否則永遠收斂不了。
          if (!healFired && rewroteSomething && (health.fail | 0) !== 0) {
            health.fail = 0; saveHealth();
          }
        }
        if (++n >= HB_MAX) stop();
      }).catch(() => { if (++n >= HB_MAX) stop(); });
    };

    // 重新導覽（含自我修復那次 reload）之後把心跳接回去，用來留下「退回英文
    // 之後確實健康」的證據。已經證明過健康的 webContents 不再重來，也不會
    // 重新起錶 —— anchored 不重設，reload 上限由 healReloads 把關。
    const restart = () => {
      if (ok || wc.isDestroyed()) return;
      // 每次真正的導覽都重新給一份基本預算，連絕對上限的起算點也一起重設。
      // 外殼視窗可能在啟動很久之後（離線／未登入時可超過 HB_ABS_MS）才導到
      // 遠端 UI；少了這兩行，它的心跳早就停了，就永遠不會起錶。
      attachedAt = Date.now();
      extend(HB_TOTAL_MS);
      n = 0;
      if (!timer) { timer = setInterval(tick, HB_EVERY); tick(); }
    };
    wc.__zhtwHb = restart;
    timer = setInterval(tick, HB_EVERY);
    tick();
  };

  // renderer 端的模組載入失敗是「我們把 bundle 改壞了」最直接的證據。只在訊息
  // 指名 zhtw:// 或任何一支我們動過的 URL 時才記 ZHTW-SCRIPTFAIL —— 安裝器把它
  // 當成硬性回滾條件，所以絕不能被無關的網路抖動觸發。
  const watchConsole = (wc) => {
    wc.on('console-message', function () {
      try {
        const a = arguments;
        let msg = '', lvl = '';
        if (a[0] && typeof a[0] === 'object' && typeof a[0].message === 'string') {
          msg = a[0].message; lvl = String(a[0].level);
        } else { lvl = String(a[1]); msg = String(a[2] || ''); }
        if (!msg) return;
        let mine = msg.indexOf('zhtw://') >= 0;
        if (!mine && hitUrl && msg.indexOf(baseName(hitUrl)) >= 0) mine = true;
        if (!mine) for (const nm of touched) { if (msg.indexOf(nm) >= 0) { mine = true; break; } }
        if (!mine) return;
        if (/Failed to (?:fetch dynamically imported module|load module script)|violates the following Content Security Policy|ERR_/i.test(msg)) {
          log('ZHTW-SCRIPTFAIL ' + lvl + ' ' + msg.slice(0, 300));
          // 第二個證據點：renderer 指名我們改過的資源載入失敗。頁面必然已經
          // 起跑（不然不會有 console 訊息），而且訊息指名的就是我們的東西。
          bumpFail('ZHTW-SCRIPTFAIL ' + msg.slice(0, 120));
        }
      } catch (e) {}
    });
  };

  app.on('web-contents-created', (_e, wc) => {
    const go = () => {
      wc.executeJavaScript(CODE, true).then((r) => log('locale 遷移注入 ' + r)).catch(() => {});
    };
    wc.on('dom-ready', go);
    wc.on('did-navigate-in-page', go);
    try { watchConsole(wc); } catch (e) {}
    let type = '';
    try { type = wc.getType(); } catch (e) {}
    if (type === 'window') {
      wc.on('dom-ready', () => watchHeartbeat(wc));
      wc.on('did-finish-load', () => watchHeartbeat(wc));
      wc.on('did-fail-load', (_ev, code, desc, url, isMain) => {
        if (isMain) log('ZHTW-NETFAIL code=' + code + ' ' + desc + ' url=' + String(url).slice(0, 120));
      });
    }
  });

  // 自動適配：啟動後在背景抓一份線上英文 catalog 存檔，供 `patch-claude sync`
  // 比對出 Claude 新版新增、尚未翻譯的字串。失敗不影響任何功能。
  app.whenReady().then(() => {
    setTimeout(() => {
      try {
        const { net } = require('electron');
        net.fetch('https://claude.ai/i18n/en-US.json')
          .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '')) ? r.text() : null)
          .then((t) => {
            if (!t) { log('線上 catalog 抓取: 非 JSON，略過'); return; }
            fs.writeFileSync(REMOTE_EN, t);
            log('線上 catalog 已存檔 ' + Math.round(t.length / 1024) + ' KB');
          })
          .catch((e) => log('線上 catalog 抓取失敗: ' + (e && e.message)));
      } catch (e) { log('線上 catalog 例外: ' + e.message); }
    }, 20000);
  });

  app.whenReady().then(() => { log('app ready'); arm(session.defaultSession, 'default'); });
  app.on('session-created', (s) => arm(s, 'new'));
  log('handlers 已註冊');
} catch (e) { log('boot 例外: ' + (e && e.stack || e)); }
require('./__ORIGINAL_MAIN__');
