# 日文歌詞羅馬拼音 Chrome Extension — 專案摘要

## 專案目標
做一個 Chrome 擴充功能，在 Spotify 網頁版即時把日文歌詞（平假名/片假名/漢字）
轉換成羅馬拼音顯示，解決不懂日文假名的人想跟唱日文歌的門檻問題。

目標是之後也能串接 Apple Music、YouTube Music，並讓所有人（不只自己）使用；
手機支援（Android 用 Kiwi Browser/Firefox、iOS 需另建 Safari Web Extension）
決定先擱置，等 Chrome 桌面版穩定上線後再回頭處理。

## 技術架構
- **形式**：Chrome Extension (Manifest V3)
- **MVP 平台**：Spotify 網頁版
- **轉換函式庫**：kuroshiro + kuroshiro-analyzer-kuromoji（處理漢字→假名→羅馬拼音）
- **歌詞來源**：優先讀取 Spotify 頁面 DOM（`[data-testid="lyrics-line"]`），
  抓不到時 fallback 到 LRCLIB 第三方歌詞 API（呼叫放在 service worker，
  避開頁面 CSP，含 7 天快取 + 併發去重）
- **同步高亮**：不觀察畫面，改用播放時間推算
  （`[data-testid="playback-position"]` 文字 + 內插）配上 LRCLIB 的 `syncedLyrics` 時間軸
- **開發工具鏈**：npm + esbuild 打包（函式庫不能從 CDN 載入，頁面 CSP 會擋，
  必須打包進擴充功能本體；kuromoji 辭典檔走 `chrome-extension://` 本地資源，
  不走網路）

## 專案結構（大致）
```
src/
├── shared/settings.js           # 顯示模式+提前量+掃描速度,content與popup共用
├── content/
│   ├── index.js                 # DOM掃描+MutationObserver+優先佇列+渲染主邏輯
│   ├── romaji.js                # kuroshiro初始化與轉換(羅馬拼音/平假名)
│   ├── macron.js                # 長音符處理(romaji.js與splitter.js共用)
│   ├── cjk.js                   # 日文字元判定、找出沒轉出來的字/漢字
│   ├── corrections.js           # 內建讀音修正字典(純邏輯,不可相依chrome)
│   ├── corrections-store.js     # 使用者自訂讀音的儲存與合併
│   ├── correction-popover.js    # 點擊補讀音的面板
│   ├── active-line.js           # 判斷正在唱哪一行
│   ├── playback-clock.js        # 播放進度(秒精度+內插)
│   ├── lrc.js                   # LRC時間軸解析(含逐字標籤)
│   ├── sync-highlight.js        # 時間軸對齊畫面歌詞、逐字上色
│   ├── splitter.js              # 手動切分羅馬拼音的資料模型與邏輯
│   ├── lrc-panel.js             # Spotify沒歌詞時的LRCLIB浮動面板
│   └── overlay.css
├── background/service-worker.js # LRCLIB查詢(含syncedLyrics)+快取
└── popup/                       # 顯示模式+提前量+掃描速度+自訂讀音管理列表
public/manifest.json
dist/                            # 實際載入到 Chrome 的資料夾
```

## 顯示模式（四選一，可在 popup 或 Spotify 頁面內建按鈕切換）
1. **純羅馬拼音**（預設）— 只顯示羅馬拼音，取代原文
2. **原文 + 下方羅馬拼音** — 兩者都顯示
3. **原文 + 平假名讀音** — 給看得懂假名、只卡在漢字的人
4. **關閉** — 只顯示原文日文

頁面內建循環切換按鈕插在 Spotify 歌詞按鈕右側，與 popup 透過
`chrome.storage.sync` 雙向即時同步。

前兩種模式的差別**純粹是 CSS**，切換時不必重新轉換；但平假名要的是
另一份文字，非重轉不可。`settings.js` 的 `conversionKind()` 就是為了
分辨這兩種切換而存在 —— 無條件重轉會讓整頁卡好幾秒，不重轉則會
永遠停在舊的那一種（旗標還是 `done`，它不會自己更新）。

平假名模式另外兩個必須分開處理的地方：
- **轉換快取的 key 要帶轉換種類**，否則切模式會拿到另一種的舊結果，
  而且因為有快取，那個錯誤會一直黏著不會自己好
- **「沒轉出來的字」換一組判斷**：假名模式的輸出本來就整片是假名，
  只有殘留的**漢字**才代表讀不出來（`cjk.js` 的 `findUnreadKanji()`）

平假名模式**不接受手動切分**：切點是字母索引，假名與拼音的字數不同，
共用同一份儲存會把空格插到錯位置，還會讓既有的拼音切分因校驗碼
對不上而整批作廢。補讀音的面板則保留。

## LRCLIB 浮動歌詞面板
Spotify 沒有這首歌的歌詞時（授權沒談成、冷門曲目），
`content/lrc-panel.js` 用 LRCLIB 抓回來的歌詞自己浮一個面板出來。

觸發條件是「歌詞檢視確實打開、且連續 12 秒等不到任何歌詞行」，
所以它處理的是**Spotify 沒歌詞**，不是「換一個歌詞來源」——
Spotify 有歌詞時這條路永遠不會被走到。要改成優先用 LRCLIB 的話，
動的是 `index.js` `tick()` 的觸發條件，不是面板。

關鍵設計：面板的每一行做成**跟 Spotify 歌詞行同構的元素**
（`data-romaji-source` + `.romaji-original` + `.romaji-overlay`）。
這一個決定換來顯示模式 CSS、手動切分的點擊委派、補讀音面板、
逐字掃描全部原封不動就能用，轉換也交還給既有的優先佇列
（`currentLineElements()` 為此抽出）。手動切分甚至是共用的：
key 是原始日文歌詞行，同一句在哪邊切都通用。

面板不需要 `alignLrc` —— 那一步是為了把 LRC 對到畫面上的行，
而面板的行本來就是照 LRC 建的，一對一。

三個容易做錯的點：
1. **自動捲動前要先把「使用者捲動」的時間戳往回撥**。`scroll` 事件
   分不出來源，不做這件事的話我們自己捲的每一下都會被記成使用者操作，
   自動捲動在第一次之後就永遠停擺
2. 面板要在換歌、Spotify 歌詞後來載進來、擴充功能重新載入時收掉
3. **「歌詞檢視被關掉」只認明確的否定**。`isLyricsViewOpen()` 找不到
   歌詞按鈕時會退回去看有沒有歌詞行，而面板開著時那個判斷一定是 false ——
   直接信它，面板會在開啟的下一秒自己關掉

## 掃描速度改成可調
`sweepMsPerLetter` 原本寫死 180，現在搬進設定、popup 可即時拖。

它只在**這首歌沒有逐字時間軸**時才用得到（有逐字資料就走真資料）。
用途不是「估得更準」——只有句首時間的話那做不到——而是限制估錯的幅度。
合適的值取決於這首歌唱得多快，那是每首歌都不一樣的；而且要驗證它對不對
非得盯著畫面看不可。與其在程式碼裡反覆猜，不如讓使用者當場拖到對為止，
跟 `syncOffsetMs` 同一個判斷。

## popup 的自訂讀音管理列表
可以檢視全部自訂讀音、直接改讀音、刪掉。popup 直接匯入
`content/corrections-store.js` 而不是自己寫一份儲存邏輯 ——
那裡面有格式版本、內建表與使用者表的合併規則、sync 容量上限檢查，
複製一份出來兩邊遲早會走鐘，而那種不一致不噴錯、只讓資料安靜地壞掉。

兩個實作細節：
- 讀音改動用 `change` 而不是 `input` 事件寫入，否則每敲一個字就寫一次
  `chrome.storage.sync`，會撞到寫入頻率上限而整批失敗
- **正在編輯時不重畫列表**：存檔本身會觸發變更回呼，重畫會把使用者
  正在打字的 input 整個換掉。用 `activeElement` 判斷而不是設旗標 ——
  焦點在不在列表裡是畫面的實際狀態，旗標要靠每個路徑記得升降，遲早會漏

## 已知問題與修正字典
kuromoji 對特定詞彙會讀錯或完全讀不出來（辭典裡沒有）。修正機制在
`corrections.js`，於丟給 kuroshiro 之前先把該詞取代成正確的假名讀音。

**「使用者回報錯誤讀音」已經實作了**，而且不必等新版發布：轉不出來的字會有
紅色波浪底線，點一下就能當場補讀音，存進 `chrome.storage.sync`，
立刻生效且所有歌曲通用（`corrections-store.js` + `correction-popover.js`）。

修正機制有三個踩過的坑，詳見 README「三個一定要知道的陷阱」：
1. 取代是**單次掃描、比對到就消耗掉**，不是逐條全域取代 ——
   否則短詞會鑽進長詞裡（`一人` 會把本來正確的 `一人称` 拆壞）
2. 讀音本來就對的詞要寫**原樣保留**的守衛條目，不可改寫成假名
   （`いちにんしょう` 反而會被拆成 `ichi ni n shō`）
3. **行內振假名**：有些歌詞把讀音以純文字寫在漢字後面（不是 `<ruby>` 標記），
   `surface` 要連同重複的那段假名一起涵蓋，否則讀音會被唸兩次

## 移除長音符
kuroshiro 預設的 Hepburn 式會把長音標成 `ō` / `ē`，那一橫在畫面上看起來
就是「拼音上面多一條線」，跟唱時只是干擾。`romaji.js` 的 `stripMacrons()`
在兩個轉換出口都會移除。

用 Unicode NFD 拆解後刪掉組合用長音符 U+0304，不是逐字對照表 ——
五個母音、大小寫、預組合字元與組合序列一次涵蓋。長度保持不變，
所以 `boundaries` 裡的字母索引仍然指在原處。

代價是長音資訊沒了（`ō` 與 `o` 變成一樣），這是刻意的取捨。

**這個改動上線時炸過一次，值得記下來。** 我當時只驗證了「長度不變」就下結論說
既有切分安全，但 `letters` 是**內容**校驗碼不是長度檢查：存的
`dōdemoiiyōnayorudakedo` 跟改完算出來的 `dodemoiiyonayorudakedo` 對不上，
使用者每一句含長音的手動切分整批被判定過期消失。長度不變是索引仍然有效的
**必要**條件，不是校驗碼會通過的充分條件 —— 兩者被我混為一談。

修法是在 `splitter.js` 的 `acceptEntry()` 加一條相容分支：直接比對失敗時，
再拿 `stripMacrons(entry.letters)` 比一次。這是同一個讀音的另一種寫法，
切點一格都沒動。分支刻意開得很窄，真正變了的讀音仍然要被判過期
（`…yorudakedo` vs `…yoruyakedo`、`sukitootta` vs `sukitoutta` 都驗證過會拒絕），
否則空格插到錯位置比切分消失更糟。

`stripMacrons()` 也因此獨立成 `src/content/macron.js`：`romaji.js` 產生資料、
`splitter.js` 比對舊資料，兩邊必須共用同一套規則。各寫一份的話，
哪天改了其中一邊，舊切分會無聲無息全部失效 —— 不噴錯，只讓使用者
覺得設定莫名其妙不見了。這支刻意零 import、零 module-level 副作用，
`splitter.js` 用它才不會把 kuroshiro 一起拖進來。

值得記的是排查過程：一開始誤判成 CSS，把 border、outline、box-shadow、
background、偽元素、祖先傳下來的 `text-decoration` 全查過都是 `none`。
真正的線索是「每個出問題的樣本都含長音母音」——
先找樣本的共同點，會比翻樣式表快得多。

## 手動切分羅馬拼音功能
因為 kuromoji 是照「詞彙邊界」斷詞，長動詞（如「透き通った」→ sukitootta）
會整個黏成一個詞沒有內部空格，讀起來卡，所以做了手動切分功能：
- **滑鼠**：點字母左半邊＝切在前面，右半邊＝切在後面，已有空格再點一次取消
- **鍵盤**：點一下/Tab 進入編輯模式顯示游標，←→移動游標，空白鍵切換切分點，
  Enter/Esc 離開並存檔
- 資料模型（`splitter.js`）存 `letters`（去空格純字母序列，兼作校驗碼）+
  `boundaries`（切點位置集合），存在 `chrome.storage.local`，
  key 用原始日文歌詞行。校驗碼機制確保修正字典更新導致讀音改變後，
  舊的切分不會插到錯位置

## 已修復的重要 bug（供參考，若日後重現可對照）
1. 歌詞面板未開啟時被誤判為「這首歌沒歌詞」而過早 fallback 到 LRCLIB
   → 改成用 `aria-pressed` 判斷面板是否真的被打開，且需連續等待一段時間才下結論
2. service worker 訊息通道因 `fetch()` 無逾時、Cloudflare 卡住連線導致
   service worker 被回收、通道無聲關閉 → 加 `AbortController` 逾時 +
   確保每條路徑都恰好呼叫一次 `sendResponse()`
3. 新增功能時兩度不慎遺漏 `index.js` 對 `DEFAULTS` 的 import，
   導致 content script 載入時 `ReferenceError` 整支崩潰（esbuild 對未定義
   全域識別字不報錯，build 階段不會攔到）→ 已修復，並新增「實際執行
   打包後 dist/content.js」的驗證步驟（用 vm 執行確認不拋錯），
   之後每次改動都應該跑這個驗證
4. 鍵盤空白鍵切分功能與 Spotify 本身「空白鍵＝播放/暫停」的快捷鍵衝突
   → 原因是 `keydown.preventDefault()` 不影響後續獨立觸發的 `keyup`；
   改用 `consumedKeys` 集合，只精準攔截被編輯模式「吃掉」的那顆按鍵的
   keydown/keypress/keyup，並處理 `window blur` 時按鍵卡住的邊界情況
5. 上一項修好之後空白鍵**又**失效，但方向鍵正常
   → 因為 `onRomajiKeydown` 是 `async`，而空白鍵那條路徑上有 `await persistSplits()`。
   事件派送是同步的，`await` 之後再呼叫 `preventDefault()`／`stopPropagation()`
   已經來不及，`consumedKeys` 也加得太晚。方向鍵沒有 await 所以不受影響。
   → **攔截動作一律在任何 await 之前同步做完**，非同步工作再放出去跑
6. 歌詞行被 Spotify 回收重用後，一直帶著上一句的舊拼音（表現為「跟聲音不同步」）
   → `needsProcessing` 的 `done` 分支只檢查 overlay 存在、沒有比對文字。
   每一種狀態都必須先比對文字，而且比對要排在 `pending` 短路**之前**
7. 部分歌詞行永遠不出現拼音
   → 中途放棄的路徑沒有清掉 `pending` 旗標，而 `needsProcessing` 對 `pending`
   回 false，該行就永久鎖死。改用 `try/finally` 解鎖，且只在「自己仍持有該行」時才解
8. 高亮不停閃爍
   → 兩條路徑（LRC 時間軸每 80ms、觀察畫面每 1 秒）搶寫同一個
   `data-romaji-active` 屬性。有時間軸可用時就不要跑觀察畫面那條
9. 第三次因為漏 import 而崩潰（`stopClock is not defined`）
   → 而且這次「用 vm 執行 dist/content.js」的煙霧測試**抓不到**：
   它只跑到模組載入，而 `shutdown()` 只有在擴充功能被重新載入時才會執行到。
   → 光靠煙霧測試不夠，還要做靜態掃描比對「呼叫了什麼」與「import 了什麼」

## 開發時最容易漏掉的一步
改完 `src/` 之後必須 `npm run build`（Chrome 載入的是 `dist/`），
然後 `chrome://extensions` 重新載入，**再回到 Spotify 分頁按 `Ctrl+Shift+R`**。

最後那步不能省：重新載入擴充功能會殺掉已開分頁裡的舊 content script，
Chrome 不會自動注入新的。漏掉時的症狀是「完全沒有任何 `[romaji]` 訊息，也沒有錯誤」，
很容易誤判成程式壞掉。舊實例還會持續噴 `Extension context invalidated`
（已加偵測讓它自我了斷，但仍需重新整理才會恢復）。

另外：Console 要看得到 `[romaji]` 訊息、或要用 `chrome.storage` 之類的 API，
**必須把左上角的 context 從 `top` 切到本擴充功能**。那個下拉選單裡會累積
很多同名的失效殘影，點到死掉的會出現 `Cannot read properties of undefined`。

## 開發模式
目前開發流程是：先在 Chat 用瀏覽器工具即時驗證想法與 DOM 結構，
確認可行後把規格交給 Claude Code（VS Code）實作，Claude Code 完成後
回來 Chat 用真實瀏覽器連線測試效果、看 Console 輸出、抓 bug，
發現問題再帶回 Claude Code 修。

## Spotify DOM 的實測結論
這個擴充功能已經被 Spotify 改版打壞過一次
（`lyrics-line-always-visible` → `lyrics-line`），所以下面每一條都是探測出來的，
**不要憑猜測改**（探測指令見 README）：

- 歌詞**容器**沒有專屬 `data-testid` → 直接抓歌詞行，observer 掛 `document.body`
- 歌詞行之間**完全沒有**屬性/class 差異，computed opacity、color 也全部相同
  → 「正在唱哪一行」不能靠歌詞行本身判斷；高亮其實套在**內層元素**上
- 頁面上**沒有** `<audio>`/`<video>`，`playback-progressbar` 也**沒有** `aria-valuenow`
  → 播放進度只能讀 `[data-testid="playback-position"]` 的文字（秒精度）
- 但文字**跳動的瞬間**很準（實測連續三次都是 1.00 秒間隔）
  → 用 MutationObserver 抓跳動當基準點 + `performance.now()` 內插，精度補到 100ms 內
- 內容有 DRM，取不到音訊本身（Web Audio 對 DRM 內容只會拿到靜音）
  → 「分析歌聲來抓唱到哪」這條路走不通
- 有些歌詞的振假名是**純文字**寫在漢字後面，不是 `<ruby>` 標記

## 同步高亮的設計取捨
兩個刻意的決定，都是實測之後才確定的：

1. **對不上就不硬做**：LRCLIB 與畫面歌詞比對低於 50%（版本不同、Live 版）
   就整組放棄，退回觀察畫面。錯位的高亮比沒有高亮更糟。
2. **逐字掃描分兩條路，要知道自己走在哪一條**：有逐字時間軸（enhanced LRC）
   時走真資料；沒有的時候依句距估算。

   估算先天無法準確 —— 只有句首時間的話，「唱得快」和「唱得慢」的句子
   在資料上**完全一樣**，任何估算都只能在兩種誤差之間換邊。
   實測驗證過：調快會變成有些句子唱完才掃完，調慢會變成快的句子拖在後面。
   所以 `index.js` 的 `SWEEP_SPAN_FACTOR`（0.92）與 `SWEEP_MS_PER_LETTER`（180）
   不是為了「估得更準」（做不到），而是把出錯幅度限制住：前者讓掃描在下一句
   開始前收尾，後者擋住「句尾接長間奏」時掃描被拖成龜速。

高亮提前量做成 popup 滑桿而不是寫死常數 —— 音訊緩衝、顯示延遲、
個人想要多少預讀時間都不同，沒有通用值。

## 目前狀態
Chrome 桌面版功能已相當完整（歌詞抓取、羅馬拼音轉換、三種顯示模式、
頁面內建切換按鈕、手動切分、鍵盤操作、LRC 同步高亮、使用者自訂讀音
皆已實作並測試通過），目前僅供開發者模式手動載入未封裝項目，
尚未上架 Chrome 線上應用程式商店。

**還沒做的**：
- LRCLIB 抓到的歌詞只輸出到 Console，還沒有顯示 UI（浮動歌詞面板）——
  資料層（`syncedLyrics` 取得、LRC 解析、播放時鐘）都已備妥，只差面板本身
- popup 的自訂讀音管理清單（可刪除；`chrome.storage.sync` 配額滿時的逃生出口）
