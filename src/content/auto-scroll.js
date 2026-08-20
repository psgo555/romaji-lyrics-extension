/**
 * auto-scroll.js
 * 換句時,自己把正在唱的那一句捲到畫面中間。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────
 * Spotify 自己也會捲,但它是照**它自己的**播放進度捲的;而我們的高亮是照
 * LRCLIB 的時間軸加上使用者設的提前量算的。兩邊本來就不會同時發生:
 * 高亮跳到下一句的那一刻,那一句還停在畫面下緣,要等 Spotify 追上來
 * 才會被捲到中間 —— 使用者看到的就是「亮了,但還在下面」。
 *
 * 再加上我們替每一行插了一列拼音,每個區塊的高度大約變兩倍,
 * 換一句要捲的距離也跟著變兩倍,Spotify 那段平滑捲動就顯得更慢。
 *
 * 所以這裡不等它,自己捲。
 *
 * ── 為什麼目標位置寫死在正中間 ──────────────────────────────
 * 實測 Spotify 捲完之後,正在唱的那一句就停在容器高度的一半上下,
 * 所以「正中間」跟它的落點幾乎一致 —— 兩邊不會互相拉扯,
 * 之後它自己再捲一次也只是幾個 px 的差距,看不出來。
 *
 * 曾經想過改成「量上一句停在哪、就把下一句放到同一個位置」自我校正,
 * 但那是一個回饋迴路:我們自己捲出來的位置會被當成量測結果再喂回去,
 * 一旦偏掉就會慢慢愈偏愈多,而且很難從畫面上看出是哪裡出問題。
 * 固定值猜錯最多差幾個 px,是比較便宜的錯。
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
 * 使用者自己捲動之後,先別跟他搶。
 *
 * 想往回看前面幾句的時候,如果每次換句都把畫面拉回來,
 * 手感會像是被畫面甩開。
 */
const USER_SCROLL_GRACE_MS = 4000;

let container = null;
let lastLineEl = null;
let userScrolledAt = 0;

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
 * 把正在唱的那一句捲到畫面中間。
 *
 * 同一行重複呼叫不會做事,所以呼叫端每 80ms 叫一次也沒關係 ——
 * 真正會動的只有換句的那一次。
 *
 * @param {HTMLElement|null} lineEl 正在唱的那一行
 */
export function centerActiveLine(lineEl) {
  if (!lineEl || lineEl === lastLineEl) return;
  lastLineEl = lineEl;

  const box = attachTo(lineEl);
  if (!box) return; // 歌詞區塊還沒長到需要捲動

  if (performance.now() - userScrolledAt < USER_SCROLL_GRACE_MS) return;

  const delta = scrollDelta(lineEl.getBoundingClientRect(), box.getBoundingClientRect());
  if (Math.abs(delta) < MIN_MOVE_PX) return;

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
  lastLineEl = null;
  userScrolledAt = 0;
}
