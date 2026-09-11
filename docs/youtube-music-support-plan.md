# YouTube Music 支援 — 技術規劃

給 Claude Code 的交接文件。以下 DOM 結構已於 2026/9/11 在 music.youtube.com 實測確認,
非猜測,可直接依此實作,不需重新探測(除非 YouTube 已改版)。

## 目標

在現有的「日文歌詞羅馬拼音」擴充功能中,新增對 YouTube Music 網頁版
(music.youtube.com)的支援,與現有 Spotify 支援並存、共用轉換引擎。

## 與 Spotify 版的關鍵差異(已實測確認)

| 項目 | Spotify(現況) | YouTube Music(新增) |
|---|---|---|
| 歌詞容器 | 每句是獨立 DOM 元素 `[data-testid="lyrics-line"]` | **整段歌詞是單一文字節點**,`\n` 分行,`childElementCount: 0` |
| 歌詞容器選擇器 | 見 DEVELOPMENT.md | `ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]` → 內部 `.description`(標籤為 `yt-formatted-string`) |
| 播放進度取得 | 抓不到 `<video>`(DRM),需用 playback-clock.js 估算 | **有官方 API**:`document.querySelector('#movie_player').getCurrentTime()`,回傳精確秒數 |
| 播放狀態 | 從畫面元素推斷 | `#movie_player.getPlayerState()`(1=播放中、2=暫停、3=緩衝中) |
| 歌詞來源標示 | Spotify 自家 | Musixmatch(頁面上會顯示「來源:Musixmatch」) |
| 是否有時間軸 | 視曲目而定 | 視曲目而定 —— **實測的 `夜に駆ける` 這首沒有時間軸**,純文字。是否所有曲目皆無時間軸尚未窮舉確認,需要多測幾首 |
| 頁面切分 | SPA,單頁 | 同為 SPA(`music.youtube.com/watch?v=...`),歌詞在右側分頁,需點擊「歌詞」分頁才會渲染出該區塊,**初始不存在,需觀察 DOM 變化或輪詢** |

## 架構決策

### 為何不能沿用 Spotify 版的 index.js 邏輯

Spotify 版是在既有的逐句元素「下方插入」羅馬拼音,不破壞原結構。
YouTube Music 沒有逐句元素可插入,**必須先把整塊文字節點拆解、重建成逐句的 DOM**,
這一步在 Spotify 版完全不存在,是全新邏輯。

參考現有 `lrc-panel.js` 的做法(該模組也是「純文字 → 重建逐句 DOM」的場景,
用於 Spotify 找不到官方歌詞、改用 LRCLIB 文字時的浮動面板),
拆解重建的邏輯可部分參考、但不能直接套用(該面板是獨立浮動 div,
YouTube Music 這裡要嵌入既有頁面結構,還要處理 Musixmatch 面板本身的重繪)。

### 可直接重用、不需重寫的模組

這些模組與平台無關,純函式邏輯:

- `romaji.js`、`corrections.js`、`corrections-store.js`、`cjk.js`、`reading.js`、`macron.js`、`numbers.js`
- `src/shared/shared-dictionary.js`、`src/shared/settings.js`(共用字典與設定同步)
- `src/background/service-worker.js` 的 LRCLIB 查詢與共用字典下載邏輯

### 需要新寫的模組(建議放在 `src/content-ytmusic/` 或以 `-ytmusic` 後綴區分)

1. **偵測與掛載**:輪詢或用 `MutationObserver` 偵測 `ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]` 出現
2. **文字拆解重建**:取得 `.description` 的 `textContent`,依 `\n\n`(段落)與 `\n`(單句)拆分,清空原內容,逐句建立元素並插入羅馬拼音(沿用 Spotify 版「每句下方插入」的顯示模式邏輯)
3. **時間軸取得**(若要做同步高亮):改用 `#movie_player.getCurrentTime()` 直接讀值,**不需要** `playback-clock.js` 那套估算邏輯,可以大幅簡化
4. **manifest.json 更新**:
   - `content_scripts[].matches` 新增 `"https://music.youtube.com/*"`
   - 若沿用同一支 `content.js` 進入點,需在程式內判斷 `location.hostname` 分流至 Spotify 或 YouTube Music 的邏輯;或拆成兩支獨立進入點各自打包

## 建議實作順序

**Phase 1(先求有,不求同步高亮)**
- 偵測歌詞面板 → 拆解文字為逐句 → 每句下方插入羅馬拼音
- 不做同步高亮,先驗證轉換引擎在新平台上正常運作

**Phase 2(視 Phase 1 情況決定是否要做)**
- 用 `#movie_player` API 做同步高亮
- 需先確認:多首不同曲目中,YouTube Music 原生歌詞面板是否曾出現過「逐句獨立元素 + 高亮」的版本(如果有些曲目走這條路徑,DOM 結構會跟這次測到的純文字版不同,需要另外處理這種分支)

## 尚待確認的問題(建議 Claude Code 開工前先實測 2-3 首不同曲目)

1. 是否所有曲目的歌詞都是純文字(無逐句元素)?或者部分曲目(尤其有「跟唱」動畫效果的)DOM 結構不同?
2. 歌詞分頁未開啟時完全不存在於 DOM,還是隱藏(`hidden` 屬性)?這決定要用 `MutationObserver` 監聽新增節點,還是監聽既有節點的屬性變化
3. 手機版網頁(m.youtube.com 或 music.youtube.com 的 RWD)DOM 是否相同?(此為次要優先)

## Phase 1 實測結果(2026-09-11)

詳細紀錄與設計理由已寫入 DEVELOPMENT.md 的「YouTube Music 支援」一節,此處僅列對上方假設的回答。

- **尚待確認 1(是否皆為純文字)**:7 首有歌詞的日文歌(夜に駆ける、Lemon、Idol、群青、ただ声一つ、紅蓮華、好きだから。)皆為單一文字節點,未見逐句元素。僅限未登入狀態,登入後是否有逐句同步版本未能確認
- **尚待確認 2(分頁未開啟時)**:shelf 完全不存在於 DOM;開啟後切回其他分頁仍留在 DOM
- **尚待確認 3(手機版)**:未測
- **與規劃不同之處**:
  - 換行不一定是 `\n`,LyricFind 來源為 `\r\n`;歌詞來源不限 Musixmatch
  - 規劃中的「內部 `.description`」有兩份,內容相同:`button[hidden]` 內的可展開版(YouTube Music 自行隱藏,`querySelector` 取到的是這份)與實際顯示的 `yt-formatted-string.non-expandable.description`。實作讀取後者、兩份皆隱藏,否則畫面會出現兩份歌詞
  - 本文之後另有 `yt-formatted-string.footer`(來源標示),自建的行接在可見本文之後,來源標示仍位於歌詞下方
  - 未採「清空原內容」:換歌時 YouTube Music 替換的是同一元素內的文字節點,改為隱藏原生、另建容器
- **端對端驗證**:以 Edge(headless)載入 `dist/` 實際操作,四種模式、換歌、關閉期間換歌後開回皆正確。Chrome 正式版已不支援 `--load-extension`,無法以同樣方式自動測試

## 完成後別忘記的事項

**這是使用者在對話中特別交代的收尾動作,實作完成、確認可動作後才做:**

在 Chrome 線上應用程式商店頁面與 GitHub README 的「使用限制」章節,
補充一條說明 Spotify 部分免費帳號可能因付費牆看不到歌詞面板(已於本次
security review 中確認,見 DEVELOPMENT.md 中「容器的 class 名稱含 paywall
字樣」一節),讓使用者在安裝前就知道這個已知限制,減少不必要的問題回報。
