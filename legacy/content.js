/**
 * content.js
 * 這是 Chrome Extension 的 content script,會被 manifest.json 宣告
 * 自動注入到 Spotify 網頁版(open.spotify.com)。
 *
 * 依賴:wanakana(打包在擴充功能內,見 manifest.json 的 content_scripts.js 順序)
 * 之後若要處理漢字,再加入 kuroshiro + kuromoji-analyzer 一併打包。
 */

const LYRICS_LINE_SELECTOR = '[data-testid="lyrics-line-always-visible"]';
const PROCESSED_FLAG = 'data-romaji-processed'; // 避免重複轉換同一行

/**
 * 把單一歌詞行元素轉換並顯示羅馬拼音
 */
function processLyricsLine(lineEl) {
  if (lineEl.hasAttribute(PROCESSED_FLAG)) return;

  const originalText = lineEl.textContent.trim();
  if (!originalText) return;

  // 目前先用 wanakana 處理純假名部分(漢字混合句留給下一階段的 kuroshiro)
  const romaji = window.wanakana.toRomaji(originalText);

  // 建立羅馬拼音的顯示元素,疊加在原歌詞下方
  const romajiEl = document.createElement('span');
  romajiEl.className = 'romaji-overlay';
  romajiEl.style.cssText = 'display:block;font-size:0.8em;color:#1db954;opacity:0.85;';
  romajiEl.textContent = romaji;

  lineEl.appendChild(romajiEl);
  lineEl.setAttribute(PROCESSED_FLAG, 'true');
}

/**
 * 掃描目前畫面上所有歌詞行並處理
 */
function processAllVisibleLines() {
  document.querySelectorAll(LYRICS_LINE_SELECTOR).forEach(processLyricsLine);
}

/**
 * 用 MutationObserver 監控歌詞面板,
 * 因為 Spotify 是 SPA,歌詞行是動態捲動載入/替換的,
 * 不能只在頁面載入時執行一次。
 */
const observer = new MutationObserver(() => {
  processAllVisibleLines();
});

function initObserver() {
  const container = document.querySelector('[data-testid="lyrics-container"]');
  if (!container) {
    // 歌詞面板可能還沒打開,稍後重試
    setTimeout(initObserver, 1000);
    return;
  }
  processAllVisibleLines();
  observer.observe(container, { childList: true, subtree: true });
}

initObserver();
