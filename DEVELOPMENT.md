# 開發說明

本文件說明架構與設計決策。使用方式請見 [README](README.md)。

## 環境建置

```bash
npm install
npm run build          # 打包至 dist/
npm test               # 180 項純函式測試
```

於 `chrome://extensions` 啟用開發人員模式,點選「載入未封裝項目」並選擇 `dist/`。

修改後須執行 `npm run check:imports`。該檢查偵測遺漏的 import —— 此類錯誤不會使打包或載入失敗,僅在執行到該路徑時才拋出 ReferenceError。

## 章節導覽

| 修改範圍 | 相關章節 |
|---|---|
| 整體架構 | 技術方案、專案結構 |
| 轉換結果不正確 | 讀音修正字典、使用者自訂讀音、長音符處理 |
| 高亮時機、逐字掃描 | 同步高亮、掃描速度 |
| Spotify 改版導致失效 | 關鍵 DOM 選擇器 |
| 畫面互動 | 手動斷字、平假名模式、LRCLIB 面板、設定介面 |
| 提交前 | 驗證項目 |

各章節記錄的多為設計理由。修改對應區塊前建議先行閱讀。

## 技術方案

| 項目 | 內容 |
|---|---|
| 形式 | Chrome Extension(Manifest V3) |
| 平台 | Spotify 網頁版 `open.spotify.com` |
| 轉換 | kuroshiro + kuroshiro-analyzer-kuromoji(漢字 → 假名 → 羅馬拼音) |
| 歌詞來源 | 優先讀取 Spotify 頁面 DOM;無歌詞時改用 LRCLIB API |

## 專案結構

```
build.mjs                       esbuild 打包、複製辭典、產生第三方聲明
public/manifest.json            MV3 設定

src/shared/
  settings.js                   設定的預設值、範圍與讀寫(content 與 popup 共用)
  shared-dictionary.js          共用讀音字典的驗證

src/content/
  index.js                      歌詞 DOM 處理、拼音插入、轉換佇列、事件委派
  romaji.js                     kuroshiro 初始化與轉換(含結果快取)
  numbers.js                    阿拉伯數字轉漢字數字(轉換前處理)
  macron.js                     長音符處理(romaji.js 與 splitter.js 共用)
  cjk.js                        日文字元判定、未轉換字的偵測
  reading.js                    讀音格式驗證與羅馬拼音轉假名
  corrections.js                內建讀音修正字典(純邏輯,不相依 chrome)
  corrections-store.js          自訂讀音的儲存與四層合併
  correction-popover.js         補讀音與修正讀音的面板
  selection-range.js            面板選詞器的範圍計算
  active-line.js                判斷目前演唱的歌詞行
  playback-clock.js             播放進度(秒精度加內插)
  lrc.js                        LRC 時間軸解析(含逐字標籤)
  sync-highlight.js             時間軸對齊與逐字上色
  auto-scroll.js                將演唱中的歌詞行捲至畫面中央
  splitter.js                   手動斷字的資料模型與渲染
  toggle-button.js              播放列上的顯示方式切換鈕
  lrc-panel.js                  LRCLIB 歌詞浮動面板
  drag-bounds.js                面板位置的邊界夾制
  notice.js                     畫面角落的暫時提示
  overlay.css                   拼音外觀、顯示模式、面板樣式

src/background/
  service-worker.js             LRCLIB 查詢、共用字典下載、快取與請求去重

src/popup/                      設定介面
tools/                          開發工具(見下)
legacy/                         早期驗證腳本,僅作紀錄
dist/                           打包產物,「載入未封裝項目」須選此目錄
```

### npm scripts

| 指令 | 用途 |
|---|---|
| `npm run build` | 打包至 `dist/` |
| `npm run watch` | 監看 `src/` 自動重新打包(靜態檔仍需重跑 build) |
| `npm test` | 純函式測試 |
| `npm run check:imports` | 遺漏 import 的靜態掃描 |
| `npm run icons` | 由 `public/icon-source.png` 產生三種尺寸的圖示 |
| `npm run demo:kana` | wanakana 純假名轉換驗證 |
| `npm run demo:kanji` | kuroshiro 漢字轉換驗證 |
| `npm run demo:corrections` | 讀音修正字典的前後對照 |

### tools/

| 檔案 | 用途 |
|---|---|
| `check-imports.mjs` | 掃描跨模組的 export 與 import,偵測遺漏 |
| `make-icons.mjs` | 產生擴充功能圖示 |
| `make-shots.mjs` | 將截圖處理為商店規格(1280×800、無 alpha) |
| `png.mjs` | 不依賴套件的 PNG 讀寫與縮放 |
| `apply-reading.mjs` | 由 issue 內容寫入 `dictionary.json`,供 CI 使用 |

## 相對於早期原型的變更

| 早期限制 | 現行做法 |
|---|---|
| 函式庫無法自 CDN 載入(頁面 CSP 阻擋) | `build.mjs` 以 esbuild 將 kuroshiro 與 kuromoji 打包進 `dist/content.js`;辭典檔複製至 `dist/dict/`,並於 manifest 的 `web_accessible_resources` 開放 |
| kuromoji 載入辭典耗時,不宜等待使用者開啟面板 | `romaji.js` 於模組載入時即啟動 `kuroshiro.init()`,`toRomaji()` 僅 await 同一個 Promise |
| LRCLIB 呼叫受頁面 CSP 限制 | 移至 `service-worker.js`,content script 透過 `chrome.runtime.sendMessage` 呼叫 |
| 「無歌詞」的判定時機 | 僅在歌詞檢視確實開啟、且連續 12 秒無任何歌詞行時才啟用備援。檢視未開啟時不作判定 |
| 僅使用 wanakana,漢字不轉換 | 改用 kuroshiro,`mode: 'spaced'`。例:`桜が咲く` → `sakura ga saku` |
| kuromoji 對部分固定讀法讀錯 | `corrections.js` 於送入 kuroshiro 前替換為正確假名 |
| Hepburn 長音符顯示為母音上方橫線 | `macron.js` 的 `stripMacrons()` 於轉換出口移除 |

## 長音符處理

kuroshiro 預設採 Hepburn 式,長音標為 `ō` / `ē`(macron)。畫面上呈現為母音上方的橫線,對跟唱並無助益。`macron.js` 的 `stripMacrons()` 於兩個轉換出口移除:`toRomaji()` 與修正面板的 `previewRomaji()`。

實作採 Unicode 正規化而非逐字對照。NFD 會將 `ō` 拆為 `o` 加組合用長音符 U+0304,移除該組合字元後再以 NFC 合併,即可涵蓋五個母音、大小寫,以及 kuroshiro 輸出預組合字元或組合序列的兩種形式。

兩項實作限制:

- **組合字元不得直接寫入原始碼。** U+0304 單獨出現時於編輯器中不可見,編輯或複製時容易遺失,且從程式碼無法察覺。應以 `String.fromCharCode(0x0304)` 指定碼位。
- **長度必須維持不變**(一字元換一字元)。`boundaries` 儲存的是字母索引,長度改變會使索引錯位。`kyō` → `kyo`、`okāsan` → `okasan` 均維持原長度,修改 `stripMacrons()` 時須保持此性質。

代價為長音資訊喪失(`ō` 與 `o` 無法區分)。此為刻意取捨,目標是可讀性而非嚴謹的轉寫。

### 對既有手動斷字的相容處理

`letters` 為**內容**校驗碼,而非僅比對長度。移除長音符後,原先儲存的 `dōdemoiiyōnayorudakedo` 與新計算的 `dodemoiiyonayorudakedo` 不相等,導致所有含長音的手動斷字被判定為過期而失效。長度不變是索引仍然有效的必要條件,但不足以通過校驗。

`splitter.js` 的 `acceptEntry()` 因此加入相容分支:直接比對失敗時,改以 `stripMacrons(entry.letters)` 再比對一次。此為同一讀音的另一種寫法,斷點位置未變。

該分支的條件刻意收窄,實際變更的讀音仍須判定過期(`…yorudakedo` 對 `…yoruyakedo`、`sukitootta` 對 `sukitoutta` 均正確拒絕)。否則空格會插入錯誤位置,後果較斷字消失更嚴重。

`stripMacrons()` 因此獨立為 `macron.js`:`romaji.js` 產生資料、`splitter.js` 比對既有資料,兩者必須使用同一套規則。分別實作會導致其中一方變更時,既有斷字全數失效且不會拋出錯誤。該模組不 import 任何項目,亦無模組層級副作用,`splitter.js` 引用時不會連帶載入 kuroshiro。

> 排查紀錄:此問題最初被誤判為 CSS 造成。border、outline、box-shadow、background、偽元素與繼承的 `text-decoration` 均為 `none`。關鍵線索是所有異常樣本皆含長音母音。檢視樣式表之前,先比對異常樣本的共同特徵較有效率。

## 手動斷字

kuromoji 依詞彙邊界斷詞,長動詞會形成無內部空格的長串(`透き通った` → `sukitootta`),不易閱讀。

斷字的操作是**空白鍵**:點擊將游標定位至目標位置,按空白鍵插入或移除該處的空格,畫面即時更新。

- 點擊字母左半 → 游標落於其前;右半 → 落於其後。亦可用左右鍵移動
- 已有空格處再按一次即移除(kuroshiro 自行產生的空格亦可移除)
- 字串頭尾無效(前導與尾隨空格無意義)

**滑鼠不執行斷字。** 早期版本為點擊即斷字,導致滑鼠無法用於其他操作:選取拼音、雙擊開啟修正面板時皆會意外插入空格,且需再次點擊同一位置才能復原。會變更資料的操作不宜綁定於最易誤觸的動作,故改為滑鼠僅負責定位與選取。`.romaji-ch:hover` 的提示底色亦改為僅在編輯模式顯示,避免暗示點擊會產生變更。

結果儲存於 `chrome.storage.local`,key 為原始日文歌詞行,再次播放同一句時自動套用。

`splitter.js` 的資料模型不儲存「已加入空格的字串」,而是:

| 欄位 | 意義 |
|---|---|
| `letters` | 移除所有空格的純字母序列,例如 `sukitootta` |
| `boundaries` | 整數集合,表示「第 i 個字母之前應有空格」 |

原因在於使用者的意圖是斷點位置。`letters` 同時作為校驗碼:若修正字典或 kuroshiro 使讀音改變而 `letters` 不符,既有斷字會被視為過期並忽略,不會將空格插入錯誤位置。

**任何會改變拼音輸出的變更,都須先評估既有 `letters` 是否仍然相符**,否則使用者的斷字設定會整批失效。前節即為此類案例。

點擊事件以**捕獲階段**委派於 `document`,以搶在 Spotify 的「點擊歌詞跳轉播放位置」之前處理;採委派而非綁定個別元素,是因為 Spotify 會持續重建歌詞行。

## 平假名模式

第四種顯示方式為原文加平假名讀音,適用於已能閱讀假名、僅受阻於漢字的使用者。羅馬拼音會將整句替換為另一套文字,包含原本即可閱讀的假名。

實作與羅馬拼音共用 `romaji.js` 的 `convert()`,差異僅在傳給 kuroshiro 的 `to` 為 `'hiragana'` 或 `'romaji'`。但有三處必須分開處理:

| 差異 | 原因 |
|---|---|
| 轉換快取的 key 須包含轉換種類 | 同一句話的拼音與假名是不同結果。僅以原文為 key 會在切換模式時取得另一種的舊結果,且因快取而持續存在 |
| 切換模式時須重新轉換 | `romaji-only` 與 `both` 之間僅為 CSS 差異,假名模式則需另一份文字。`conversionKind()` 用於區分這兩種切換;無條件重新轉換會使整頁停頓數秒 |
| 未轉換字的判定不同 | 拼音模式下任何殘留日文皆屬失敗;假名模式的輸出本即為假名,僅殘留**漢字**代表無法讀出。`cjk.js` 因此提供 `findUnreadKanji()` |

**平假名模式不支援手動斷字。** 斷點為字母索引,而同一句的假名字數與拼音字母數不同,共用同一份儲存會使空格插入錯誤位置,並使既有的拼音斷字因校驗碼不符而失效。點擊處理中設有明確防線(僅不提供鍵盤焦點無法阻擋滑鼠)。修正面板則保留,該模式同樣需要補上無法讀出的漢字。

## LRCLIB 歌詞面板

部分曲目 Spotify 未提供歌詞。此時歌詞檢視為空,原有流程無元素可處理。`lrc-panel.js` 於此情況下以 LRCLIB 的歌詞建立浮動面板。

**觸發條件為歌詞檢視已開啟、且連續 12 秒無任何歌詞行。** 因此其處理的是「Spotify 無此曲目歌詞」,而非「更換歌詞來源」——Spotify 有歌詞時不會進入此路徑。若欲改為優先使用 LRCLIB,應修改 `index.js` `tick()` 中的觸發條件,而非面板本身。

面板的每一行刻意與 Spotify 歌詞行同構:

```html
<li data-romaji-source="原文">
  <span class="romaji-original">原文</span>
  <span class="romaji-overlay">…逐字 span…</span>
</li>
```

顯示模式的 CSS、手動斷字的點擊委派、修正面板、逐字掃描的 `paintSweep` 因此可直接套用,無須為面板另行實作。轉換亦交由 `index.js` 既有的優先佇列處理(`currentLineElements()` 即為此抽出),「演唱中的行優先轉換」在面板上同樣成立。手動斷字亦為共用:key 為原始日文歌詞行,同一句在 Spotify 歌詞上的設定於面板上直接生效。

高亮不需要 `alignLrc`。該步驟用於將 LRC 句子對應至畫面上的行,而面板的行本即依 LRC 建立,為一對一關係。

面板可拖曳與縮放,位置與尺寸儲存於 `chrome.storage.local`。相關實作重點:

- **邊界夾制的目的是可回復性。** 標題列為唯一的拖曳把手,超出畫面後即無法以滑鼠選取,只能重新整理頁面。`drag-bounds.js` 的 `clampToViewport()` 確保面板始終部分位於畫面內,視窗縮小時亦會重新夾制。
- **改用 left/top 定位前須先固定高度。** 面板原以 top/right/bottom 撐出高度,移除 bottom 後會縮至標題列高度。
- **mousemove 與 mouseup 綁定於 `document`。** 快速拖曳時放開滑鼠的位置常已離開面板,綁定於面板會遺漏該事件。
- **尺寸變更以 ResizeObserver 監聽**,瀏覽器內建的 resize 把手不會發出可攔截的事件。寫入須節流:拖曳期間每幀觸發,而 storage 有寫入頻率上限,超過後其他功能的儲存亦會失敗。
- **字級隨面板寬度變化**(`3.6cqw`,上下限 13px 與 26px)。預設寬度 360px 時恰為 13px,與固定字級時相同。

其他注意事項:

- **自動捲動須讓位於使用者操作。** 使用者捲動後 4 秒內不介入,否則無法往回查看。`scroll` 事件無法區分來源,故自動捲動前須將「使用者捲動」的時間戳往前調整,否則自動捲動在第一次之後即停止運作。
- **面板須於適當時機關閉**:換歌、Spotify 歌詞後續載入、擴充功能重新載入。使用者關閉過的曲目不再自動開啟。
- **歌詞檢視關閉僅認定明確的否定值。** `isLyricsViewOpen()` 找不到歌詞按鈕時會退而檢查畫面上是否有歌詞行,而面板開啟時該判斷必為 false。直接採用其結果,會使面板在找不到按鈕的 Spotify 版本上於開啟後立即關閉。

## 掃描速度

`sweepMsPerLetter` 僅在曲目**無逐字時間軸**時使用;有逐字資料時完全不參與。

其用途並非提高估算精度(僅有句首時間時無法達成),而是限制估算誤差的幅度。句尾接續長間奏時,句距會遠大於實際演唱長度,依句距推算會導致整句唱完僅掃描四分之一,此時改以字數封頂。

適當值取決於曲目的演唱速度,無通用數值。目前未提供使用者介面,採預設值 180。

## 讀音修正字典

kuromoji 的內建辭典(IPADIC)對部分固定讀法的詞會給出語境不符的讀音,例如拆解整個詞、以最常見的單字讀音拼合。

`corrections.js` 為修正表。原理是在送入 kuroshiro 之前,先將已知讀錯的詞以字串替換為正確的平假名。kuroshiro 不會重新判定平假名的讀音,會直接轉為羅馬拼音,因此替換過的部分保證正確,無須修改 kuromoji 的內部辭典。

新增條目:

```js
{ surface: '原文漢字', reading: 'ただしいよみ' },
```

無須自行排序,`corrections.js` 會依原文長度由長至短排列。修改後執行 `npm run demo:corrections` 檢視前後對照,再執行 `npm run build`。

### 三項限制

**一、替換為單次掃描,比對成功即消耗該段,而非逐條全域替換。**

早期版本對每一條執行 `split().join()` 掃過整個字串,導致短詞會進入已由長詞處理過的區段 —— 加入 `一人 → ひとり` 後,原本正確的 `一人称` 會被拆為 `ひとり称`。現行做法為由左至右掃描一次,比對成功即消耗該段,長詞因此能保護短詞。

**二、讀音原本正確的詞,守衛條目須維持原樣。**

```js
{ surface: '一人称', reading: '一人称' },   // 原樣保留
```

不可改寫為假名。kuromoji 對 `いちにんしょう` 會拆為 `ichi ni n shō`,結果更差。替換為假名並非總是較佳,僅在原本讀錯時適用。

**三、行內振假名:漢字後方可能已附帶其讀音。**

部分歌詞來源會將讀音以純文字寫於漢字之後(**非** `<ruby>` 標記)。此時 `surface` 須涵蓋漢字與後方重複的假名,`reading` 僅保留假名:

```js
{ surface: '藻掻もが', reading: 'もが' },   // 正確
{ surface: '藻掻',     reading: 'もが' },   // 錯誤:原有假名會被保留,讀音出現兩次
```

判定方式:畫面上出現讀音重複(例如 `mo ga mogai te`)即屬此類。

`index.js` 的 `extractRuby()` 另行處理真正的 `<ruby>` 標記(存在 `<rt>` 時直接採用)。目前實測的來源未使用該標記,但 Spotify 有多個歌詞來源,故予以保留。

### 阿拉伯數字

kuromoji 不處理阿拉伯數字,會將其原樣輸出:`50年を50億で買おう` 轉換後為 `50 nen o 50 oku de kao`。

`numbers.js` 在轉換前將阿拉伯數字改寫為漢字數字。採此做法而非直接拼寫假名,是因為量詞的讀法不規則(`一つ` → ひとつ、`一人` → ひとり、`八日` → ようか),而這些規則已存在於辭典中。改寫為漢字後,`五十年`、`一つ` 皆為辭典中的詞,讀音由辭典決定。

三種情況不予改寫:英文字母相鄰(`mp3`、`Y2K`)、前導為零(`007`、`03`)、長度超過 16 位。

## 使用者自訂讀音

無須修改程式碼重新建置。未轉換的字會標示紅色波浪底線,點擊即可補上讀音,儲存於 `chrome.storage.sync`,立即生效且適用於所有曲目。

面板提供即時預覽,使用者可據以判斷選取範圍是否涵蓋整個詞 —— 僅選取部分會導致斷詞被破壞或讀音重複。

### 兩個進入點

| 進入方式 | 情況 | 標題 | 預選範圍 |
|---|---|---|---|
| 點擊紅色波浪底線的字 | 該詞無法轉換 | 補上讀音 | 已選定該詞 |
| 雙擊(拼音或原文皆可) | 該詞轉換錯誤,例如 心の臓 → `kokoro no` | 修正讀音 | 見下 |

雙擊時的預選範圍取自當下選取的原文:先以滑鼠選取日文字再雙擊,面板開啟時範圍即為該段(`surfaceFromSelection`,限定同一行且須確實出現於該行原文中)。

選取拼音則不予採用,面板會以空白範圍開啟。轉換過程未保留「拼音字母對應原文哪幾個字」的關係,僅能依比例推估,而錯誤的預選比無預選更糟 —— 使用者會視其為系統判定的結果並直接儲存,實際修改到相鄰的字。純拼音模式無法看到原文,一律採此路徑。

選詞器支援兩種操作:點擊延伸或縮小範圍(微調),按住拖曳一次選取一段。拖曳時僅更新 `aria-pressed` 而不重建節點 —— 每移動一個字即重建整排按鈕會使滑鼠下方的元素被替換,`mouseenter` 隨即再次觸發。

儲存的是**讀音**而非拼音字母。直接修改拼音僅對該句有效,更換曲目或翻唱版(斷句不同)即不適用;修改讀音則作用於源頭,任何曲目出現該詞皆正確,亦為可分享的前提。

雙擊與手動斷字的互動:瀏覽器的雙擊事件序列為 `click → click → dblclick`。滑鼠已不執行斷字,第一次點擊僅定位游標,無須復原。面板開啟時點擊拼音僅關閉面板。

| 模組 | 職責 |
|---|---|
| `corrections.js` | 純邏輯,**不可相依 `chrome.*`**(`npm run demo:corrections` 以 Node 直接匯入) |
| `corrections-store.js` | chrome.storage 讀寫、四層合併、配額防護 |
| `correction-popover.js` | 畫面與互動 |
| `selection-range.js` | 選詞器的範圍計算(純函式,可測試) |
| `shared/shared-dictionary.js` | 共用字典的驗證(純資料,可測試) |

### 共用字典的兩個層級

生效順序為**使用者自訂 > 該曲目專屬 > 共用通用 > 內建**。

| 層級 | 範圍 | 收錄內容 |
|---|---|---|
| `entries` | 所有曲目 | 任何曲目皆為相同讀音的詞(人名、固定讀法) |
| `songs[].entries` | 僅該曲目 | 其餘 |

分層的原因在於回報者無法判斷一筆修正在其他曲目中是否安全。「失 → な」在該曲目正確,置於通用條目則會使「失敗」變為 `nahai`、「失う」變為 `nau`。要求回報者評估此點,等同限縮為僅懂日文者可用。

限定於單一曲目即無須此判斷:錯誤僅影響該曲目,而同一曲目的其他使用者可直接取得修正結果。因此「分享給大家」送出的 issue 預設為限定單曲,曲名自動帶入;是否提升為通用條目由維護者決定。

`songs[].title` **僅比對曲名,不比對歌手**,使翻唱版得以套用同一筆修正。同名曲目的風險有限:條目生效除曲名相同外,該詞尚須確實出現於歌詞中。

**格式版本刻意未變更。** `songs` 為新增的頂層欄位,舊版擴充功能僅讀取 `entries`,不會處理該欄位,因此舊版取得新檔案仍完全正確,僅缺少限定單曲的條目。變更版本號反而有害:舊版的規則為「無法辨識的版本整份捨棄」,將使未更新的使用者連通用條目一併失去。判斷標準為舊版是否會產生錯誤行為,而非格式是否變動。

`chrome.storage.sync` 單一項目上限為 8192 bytes,寫入前會先量測(門檻 7000)並於超過時明確告知,同時鏡像一份至 `chrome.storage.local`。

內建字典目前 7 筆,其中包含守衛條目與行內振假名的示範:

| 原文 | 讀音 | 用途 |
|---|---|---|
| 響めき | `どよめき` | 固定讀法 |
| 二人 | `ふたり` | 固定讀法(歌詞高頻) |
| 一人 | `ひとり` | 固定讀法 |
| 一人称 | 原樣保留 | 守衛,阻擋「一人」進入 |
| 心の臓 | `しんのぞう` | 固定讀法 |
| 熄み | `やみ` | 固定讀法 |
| 藻掻もが | `もが` | 行內振假名的處理示範 |

執行 `npm run demo:corrections` 可檢視前後對照。

## 設定介面

顯示方式共四種:

| 值 | 標籤 | 按鈕文字 | 行為 |
|---|---|---|---|
| `romaji-only` | 純羅馬拼音(預設) | 拼 | 隱藏原文,僅顯示拼音 |
| `both` | 日 + 羅馬拼音 | 拼日 | 兩者皆顯示 |
| `kana` | 日 + 平假名 | 假名 | 原文加平假名讀音 |
| `off` | 關閉 | 關 | 僅顯示原文,不進行轉換亦不插入元素 |

其他設定:

| 項目 | 鍵 | 範圍 | 預設 |
|---|---|---|---|
| 高亮提前量 | `syncOffsetMs` | −500 至 2000 ms,級距 50 | 0 |
| 拼音顏色 | `romajiColor` | 六組常用色或自訂 | `#1db954` |
| 拼音字級 | `romajiScale` | 60–120% | 80 |

提前量做成可調而非固定值,是因為 Spotify 顯示的秒數本身落後實際音訊、系統音訊輸出有緩衝,且跟唱需要提前看到文字。這些延遲因人與裝置而異,無通用數值。

設定儲存於 `chrome.storage.sync`,content script 透過 `storage.onChanged` 立即套用,無須重新整理。顏色與字級以 CSS 變數實作,不需重新轉換。

### 播放列切換鈕

播放列的「歌詞」按鈕右側提供切換鈕,點擊依序循環四種模式。啟用轉換時為 Spotify 綠,關閉時轉為灰色並降低不透明度;tooltip 顯示目前模式與下一個模式。

該按鈕不自行保存狀態,而是寫入同一份 `chrome.storage.sync`,再由 `storage.onChanged` 更新外觀。頁面按鈕與設定介面因此共用同一真相來源,任一處變更另一處會即時反映。

播放列由 React 重建時按鈕會被移除,`tick()` 每秒確認位置並在需要時重新插入;歌詞按鈕消失(未播放)時一併移除。`off` 模式仍保留按鈕,否則無法從頁面重新啟用。

`romaji-only` 與 `both` 之間的切換為純 CSS,不重新轉換,原文始終保留於 DOM 中僅隱藏。`off` 則使 content script 完全略過處理,切回時會自動補掃該期間出現的歌詞行。

早期版本的 `enabled` 欄位與 `'below'` / `'above'` 等值已不再使用。`getSettings()` 對無法辨識的值會退回預設,無須手動清除。

## 關鍵 DOM 選擇器

以下為 Spotify 網頁版的實測結果(2026-08)。

```
單行歌詞: [data-testid="lyrics-line"]
歌詞按鈕: [data-testid="lyrics-button"]
播放進度: [data-testid="playback-position"]     文字,格式 "0:25"
歌曲長度: [data-testid="playback-duration"]     文字,格式 "4:03"
```

歌詞按鈕的 `aria-pressed` 用於判定使用者是否確實開啟歌詞檢視,為 LRCLIB 備援的前提條件。

### 實測結論

本擴充功能曾因 Spotify 改版而失效(`lyrics-line-always-visible` → `lyrics-line`)。以下各項均為實際探測結果,不宜以推測取代。

| 觀察 | 影響 |
|---|---|
| 歌詞**容器**無專屬 `data-testid` | 不使用容器選擇器,直接取歌詞行,observer 掛於 `document.body` |
| 歌詞行之間無屬性或 class 差異,computed opacity 與 color 亦相同 | 無法由歌詞行本身判定演唱中的行 |
| 高亮實際套用於**內層元素** | `active-line.js` 的 `inner-style` 策略讀取內層樣式,實測為勝出策略 |
| 頁面無 `<audio>` / `<video>` 元素 | 無法取得 `currentTime`;內容具 DRM,音訊本身亦無法取得 |
| `playback-progressbar` 無 `aria-valuenow`,亦無 `[role="slider"]` | 無現成數值可讀 |
| 進度僅有秒精度,但文字**跳動的瞬間**準確(實測連續三次間隔皆為 1.00 秒) | `playback-clock.js` 以 MutationObserver 擷取跳動作為基準點並內插,精度可達 100ms 以內 |
| 部分歌詞的振假名為純文字置於漢字後,非 `<ruby>` 標記 | 見「讀音修正字典」的行內振假名一節 |

亦曾探測播放速度控制的可行性:主頁面與所有同源 iframe 均無媒體元素,攔截 `HTMLMediaElement.prototype.play` 亦無觸發,判定 Spotify 網頁版未使用媒體元素播放,`playbackRate` 無從設定。

### 選擇器失效時的排查

失效時 content script 不會拋出錯誤,而是靜默停止作用。於頁面 Console 檢視 `[romaji]` 開頭的訊息,**須將左上角的 context 由 `top` 切換至本擴充功能**,否則無法看到訊息亦無 `chrome` API。

```js
// 目前與歌詞、播放相關的 testid
[...document.querySelectorAll('[data-testid]')].map(e => e.dataset.testid)
  .filter((t,i,a) => a.indexOf(t) === i).filter(t => /lyric|play|progress|position/i.test(t));

// 單行歌詞的實際結構
document.querySelector('[data-testid="lyrics-line"]').innerHTML;
```

容器的 class 名稱含 "paywall" 字樣,部分帳號類型可能無法顯示歌詞面板。

## 同步高亮

高亮不由觀察 Spotify 畫面推斷。該方式先天延遲,且無法取得句子內部的進度。改以播放時間推算:

```
playback-position 文字跳動 → 基準點 + performance.now() 內插 → 目前毫秒
LRCLIB syncedLyrics → parseLrc → 每一句的起始時間
兩者對齊 → 目前句次 + 該句進度
```

| 模組 | 職責 |
|---|---|
| `playback-clock.js` | 播放進度(秒精度加內插)、暫停偵測、拖動進度條後重新對齊 |
| `lrc.js` | LRC 解析(含逐字標籤 `<mm:ss.xx>`) |
| `sync-highlight.js` | 時間軸對齊畫面歌詞、計算進度、逐字上色 |

### 對齊失敗時不強行套用

LRCLIB 與畫面歌詞的比對低於 50%(版本不同、Live 版)即整組放棄,退回觀察畫面的方式。錯位的高亮較無高亮更糟。

此時畫面表現與故障相近,且設定中的提前量滑桿不會產生任何效果。因此在 LRCLIB 無同步歌詞、或時間軸對不上兩種情況下,會於畫面左下角顯示一則自動消失的提示(`notice.js`),說明拼音仍正常顯示但不會逐字高亮。

### 逐字掃描的兩條路徑

具備逐字時間軸(enhanced LRC)時採用實際資料;無逐字資料時依句距估算。

估算先天無法精確:僅有句首時間時,演唱速度不同的句子在資料上完全相同,任何估算只能在兩種誤差之間取捨。因此下列兩個參數的用途是限制誤差幅度,而非提高精度。

| 參數 | 位置 | 作用 |
|---|---|---|
| `SWEEP_SPAN_FACTOR`(0.92) | `index.js` | 句中換氣與停頓使實際演唱短於句距,等速掃描會偏慢。乘以略小於 1 的係數,使掃描於下一句開始前結束 |
| `sweepMsPerLetter`(180) | `settings.js` | 句尾接續長間奏時句距遠大於演唱長度,依句距掃描會導致整句唱完僅掃描四分之一。改以字數封頂 |

掃描整體偏快或偏慢時調整上述參數;整體與歌聲不同步則屬提前量問題,應調整設定中的滑桿。

## 驗證項目

每次改動均須執行下列三項,順序不可調換:

```bash
npm test               # 純函式測試(180 項)
npm run check:imports  # 遺漏 import 的靜態掃描
npm run build          # src/ → dist/
```

隨後於 `chrome://extensions` 重新載入擴充功能,並於 Spotify 分頁執行 `Ctrl+Shift+R`。

最後一步不可省略:重新載入擴充功能會終止既有分頁中的 content script,而 Chrome 不會自動注入新的執行個體。省略時的症狀為完全無 `[romaji]` 訊息,亦無錯誤。

### 遺漏 import 的檢查

esbuild 對未定義的全域識別字不報錯,建置階段無法攔截。以 vm 執行 `dist/content.js` 的煙霧測試僅涵蓋模組載入,無法偵測僅在特定分支才會呼叫的遺漏(例如僅於擴充功能重新載入時執行的 `shutdown()`)。

因此需另行靜態掃描,比對各模組「呼叫的名稱」與「import 的名稱」。實作於 `tools/check-imports.mjs`。

**掃描器回報無問題不等於實際無問題。** 第一版對真實 `src/` 回報通過,以複製的程式碼還原歷史上兩處遺漏進行驗證後,才發現其僅能偵測 `stopClock`,完全無法偵測 `DEFAULTS`。原因為兩個獨立的缺陷:

- `{ ...DEFAULTS }` 的展開運算子被「排除 `obj.prop`」的規則誤判為屬性存取而整段略過
- 將所有 `(…)` 後接 `{` 視為函式參數列,使 `if (x) {` 的條件內容進入白名單,任何出現於 if 條件中的名稱均被忽略

修改該工具前應先閱讀其檔頭註解,並以「複製 src、移除一個 import、確認能被偵測」的方式驗證。

### 自動測試

測試位於 `test/`,使用 Node 內建測試工具,不需額外套件,亦不載入 kuromoji 辭典。

| 檔案 | 涵蓋範圍 |
|---|---|
| `corrections.test.js` | 長詞優先、消耗式比對、內建讀音逐筆對照、空原文的無限迴圈防護 |
| `macron.test.js` | 長音符移除,重點為長度不變 |
| `numbers.test.js` | 阿拉伯數字轉漢字數字,含不予改寫的三種情況 |
| `lrc.test.js` | 時間標籤換算、多標籤展開、逐字標籤、offset |
| `cjk.test.js` | 日文判定、未轉換字的偵測、字串位置換算字母索引 |
| `reading.test.js` | 讀音格式驗證、羅馬拼音轉假名 |
| `sync-highlight.test.js` | 對齊(含重複副歌)、補洞後強制遞增、逐字進度內插 |
| `settings.test.js` | 值的正規化、模式循環、顏色與字級的範圍 |
| `selection.test.js` | 選詞器的範圍計算 |
| `drag-bounds.test.js` | 面板位置的邊界夾制 |
| `auto-scroll.test.js` | 捲動距離計算 |
| `shared-dictionary.test.js` | 共用字典驗證,含限定單曲的條目 |
| `apply-reading.test.js` | issue 內容解析、寫入字典、以驗證器覆核 |

測試本身以注入已知錯誤的方式驗證過:

- 將「二人」的讀音改為無關值 → 2 項失敗
- 使 `stripMacrons` 改變字串長度 → 4 項失敗

兩者均回傳非零結束碼。第一項尤其重要,該類錯誤正是 `legacy/` 的三支示範腳本無法偵測的(其會照常輸出「已修正」並以 0 結束)。

`legacy/` 的三支腳本已更名為 `npm run demo:kana` / `demo:kanji` / `demo:corrections`,名稱上標明其為目視示範而非驗證。需檢視含辭典的實際轉換結果時使用。

### 其他已驗證項目

- esbuild 正確套用 kuromoji 的 `browser` 欄位,打包結果為 `BrowserDictionaryLoader`(以 XHR 讀取 `.dat.gz`),未殘留 Node 的 `fs`
- LRCLIB 請求以 Node 測試會得到 403(Cloudflare 阻擋自動化流量),自擴充功能發出的請求可通過。測法:`chrome://extensions` → service worker → Console → `await fetchLyrics('曲名', '歌手名')`,再次執行應顯示命中快取且無網路請求

## 待處理事項

- **`chrome.storage.local` 的手動斷字資料無上限亦無過期機制**(`split:` 前綴)。實測 26 筆連同歌詞快取約 277KB,距上限尚遠,但僅增不減。可考慮加入 LRU 或過期機制,並於設定介面提供清除入口(自訂讀音已有管理清單,斷字尚無)
- **LRCLIB 快取僅於讀取時檢查過期**,未再播放的曲目記錄會持續保留
- **平台相關的選擇器分散於 `index.js` 與 `playback-clock.js`**。抽出為設定檔後,新增其他平台僅需增加對應檔案
- 專案尚無 linter 與 formatter

> 加入功能後應同步移除此處對應項目。過期的待辦清單較無清單更糟,會使閱讀者誤判功能不存在而重複實作。

### 清除歌詞快取

變更曲目挑選邏輯(語言、版本)後,既有記錄仍以舊規則挑選。於 `chrome://extensions` → service worker → Console:

```js
const all = await chrome.storage.local.get(null);
const keys = Object.keys(all).filter((k) => k.startsWith('lrclib:'));
await chrome.storage.local.remove(keys);
console.log('已清除', keys.length, '筆');
```

僅清除歌詞快取,手動斷字(`split:` 前綴)不受影響。
