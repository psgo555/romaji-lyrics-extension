/**
 * auto-scroll.js
 * Spotify 沒把正在唱的那一句帶回畫面中間時,補捲一下。
 *
 * ── 這是補救,不是主力 ────────────────────────────────────────
 * 捲動本來就該由 Spotify 自己做,而且換句的時機現在已經跟它對錶了
 * (見 line-anchor.js),所以絕大多數時候它自己會處理好。
 *
 * 但我們替每一行插了一列拼音,每個區塊的高度大約變兩倍,換一句要捲的
 * 距離也跟著變兩倍;偶爾會出現它捲得不夠、那一句停在畫面下緣的情況。
 * 這裡就是為那種時候準備的。
 *
 * ── 為什麼要等一下再判斷 ────────────────────────────────────
 * 換句的當下 Spotify 自己的捲動動畫正要開始。那一刻就跟著捲的話,
 * 兩邊會在同一個容器上互相搶,畫面反而抖。所以先讓它捲,
 * 等它該做完了再看結果 —— 位置對了就什麼都不做。
 *
 * ── 為什麼目標位置寫死在正中間 ──────────────────────────────
 * 實測 Spotify 捲完之後,正在唱的那一句就停在容器高度的一半上下。
 * 曾經想過改成「量上一句停在哪、就把下一句放到同一個位置」自我校正,
 * 但那是一個回饋迴路:我們自己捲出來的位置會被當成量測結果再喂回去,
 * 一旦偏掉就會慢慢愈偏愈多,而且很難從畫面上看出是哪裡出問題。
 */

import { findScrollParent } from './active-line.js';

/** 正在唱的那一句要停在容器高度的這個比例上 */
const FOCUS_RATIO = 0.5;

/**
 * 差距小於這個距離就不動。
 *
 * Spotify 自己也在捲同一個容器,兩邊目標差個幾 px 是必然的。
 * 沒有這道門檻的話,每次換句都會補一次幾乎看不見的捲動,
 * 反而讓畫面一直有細微的抖動。
 */
const MIN_MOVE_PX = 24;

/**
 * 換句之後先讓 Spotify 捲這麼久,再看它有沒有捲到位。
 *
 * 這是這支模組唯一的存在理由:不跟它搶。它的捲動動畫大約半秒,
 * 留一點餘裕。等太久使用者會先看到不順,等太短就會打架。
 */
const SETTLE_MS = 700;

/**
 * 使用者自己捲動之後,先別跟他搶。
 *
 * 想往回看前面幾句的時候,如果每次換句都把畫面拉回來,
 * 手感會像是被畫面甩開。
 */
const USER_SCROLL_GRACE_MS = 4000;

let container = null;
let userScrolledAt = 0;

/** 正在觀察的那一行,以及它是什麼時候變成正在唱的 */
let pendingEl = null;
let pendingAt = 0;
/** 這一行已經判斷過了,不再重複判斷 */
let judged = false;

/**
 * 記錄「使用者自己動了」。
 *
 * 刻意**不聽 scroll 事件** —— 這個容器上有三個捲動來源:使用者、Spotify、
 * 以及我們自己。scroll 事件分不出來源,聽它的話 Spotify 每次自動捲動
 * 都會被當成使用者操作,自動置中會在第一次換句之後就永遠停擺。
 * wheel / touchmove / 按鍵則只有真的動手才會發生。
 */
const USER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'];

function noteUserScroll() {
  userScrolledAt = performance.now();
}

function attachTo(lineEl) {
  const next = findScrollParent(lineEl);
  if (next === container) return container;

  for (const type of USER_EVENTS) container?.removeEventListener(type, noteUserScroll);
  for (const type of USER_EVENTS) next?.addEventListener(type, noteUserScroll, { passive: true });

  container = next;
  // 換了容器(換歌、重開歌詞檢視)就不該繼承上一個容器的「使用者剛捲過」
  userScrolledAt = 0;
  return container;
}

/**
 * 算出要捲多少距離才會讓這一行落在焦點上。
 * 抽出來是為了能離開瀏覽器測試 —— 兩個矩形進去,一個數字出來。
 *
 * @param {{top: number, height: number}} lineBox 這一行的位置
 * @param {{top: number, height: number}} viewBox 捲動容器的可視範圍
 * @returns {number} 要捲的距離(正的往下)
 */
export function scrollDelta(lineBox, viewBox) {
  const lineCenter = lineBox.top + lineBox.height / 2;
  const focus = viewBox.top + viewBox.height * FOCUS_RATIO;
  return lineCenter - focus;
}

/**
 * 檢查正在唱的那一句在不在畫面中間,不在就補捲一下。
 *
 * 呼叫端每 80ms 叫一次。換句之後會先等 SETTLE_MS 讓 Spotify 自己捲,
 * 然後只判斷一次 —— 位置對了就什麼都不做。
 *
 * @param {HTMLElement|null} lineEl 正在唱的那一行
 */
export function centerActiveLine(lineEl) {
  if (!lineEl) return;

  if (lineEl !== pendingEl) {
    pendingEl = lineEl;
    pendingAt = performance.now();
    judged = false;
    return; // 換句的當下不動,先讓 Spotify 捲
  }

  if (judged) return;
  const now = performance.now();
  if (now - pendingAt < SETTLE_MS) return;
  judged = true;

  const box = attachTo(lineEl);
  if (!box) return; // 歌詞區塊還沒長到需要捲動

  // 使用者剛剛自己捲過就先不要搶,等他停手一段時間
  if (now - userScrolledAt < USER_SCROLL_GRACE_MS) return;

  const delta = scrollDelta(lineEl.getBoundingClientRect(), box.getBoundingClientRect());
  if (Math.abs(delta) < MIN_MOVE_PX) return; // Spotify 已經捲到位了

  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * 換歌、關閉歌詞檢視時把狀態清掉。
 * 不清的話,下一首歌的第一句如果剛好是同一個元素(Spotify 會重用 DOM),
 * 就會被當成「還是同一行」而不捲。
 */
export function resetAutoScroll() {
  for (const type of USER_EVENTS) {
    container?.removeEventListener(type, noteUserScroll);
  }
  container = null;
  pendingEl = null;
  judged = false;
  userScrolledAt = 0;
}
