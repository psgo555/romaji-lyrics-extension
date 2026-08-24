/**
 * auto-scroll.js
 * Spotify 未將演唱中的句子帶回畫面中央時,補足捲動。
 *
 * 此為補救機制而非主要手段。捲動本應由 Spotify 自行處理,換句時機亦已與其對齊
 * (見 sync-highlight.js),多數情況下無須介入。但每一行皆插入一列拼音後,
 * 區塊高度約增為兩倍,換句所需的捲動距離亦隨之加倍,偶爾會出現捲動不足、
 * 該句停留於畫面下緣的情況。
 *
 * 判斷須延後執行:換句當下 Spotify 自身的捲動動畫正要開始,同時介入會使雙方
 * 爭奪同一個容器,畫面反而抖動。因此先讓其完成,再檢視結果 —— 位置正確即不處理。
 *
 * 一次誤判的紀錄(2026-08):使用者回報「沒有同步歌詞的歌,連 Spotify 內建的
 * 跟唱置中也不見了」。當時判定為本模組所致並將其整個移除,理由是捲動事件無從
 * 區分來源,Spotify 可能將我們的 scrollBy 視為使用者操作而停用自動置中。
 *
 * 該推論並不成立。停用整個擴充功能後症狀完全相同,且 Spotify 自身即於該曲上方
 * 標示「這些歌詞尚未與歌曲同步」—— 該曲並無時間軸,本就不會跟隨。
 *
 * 保留此段紀錄的原因:該推論表面合理,日後仍可能再次被提出。若要懷疑本模組,
 * 應先停用整個擴充功能進行比對,較閱讀程式碼快得多。
 *
 * 風險本身依然存在(我們確實在操作一個由 Spotify 管理的容器),
 * 但目前沒有任何證據顯示它曾實際發生。
 *
 * 目標位置固定於容器正中央。實測 Spotify 捲動完成後,演唱中的句子即停留於容器
 * 高度的一半附近。曾評估改為「量測上一句的停留位置,將下一句置於同一位置」的
 * 自我校正作法,但該作法構成回饋迴路:自身捲出的位置會作為量測結果再次輸入,
 * 一旦偏移即會持續累積,且難以從畫面判斷問題來源。
 */

import { findScrollParent } from './active-line.js';

/** 演唱中的句子應停留於容器高度的此一比例 */
const FOCUS_RATIO = 0.5;

/**
 * 差距小於此距離即不處理。
 *
 * Spotify 同時亦在捲動同一個容器,雙方目標相差數 px 屬必然。
 * 缺少此門檻時,每次換句都會補上一次幾乎不可見的捲動,造成畫面持續細微抖動。
 */
const MIN_MOVE_PX = 24;

/**
 * 換句後先讓 Spotify 捲動此一時間,再檢視其是否到位。
 *
 * 此即本模組存在的唯一理由:不與其爭奪。Spotify 的捲動動畫約半秒,此處留有餘裕。
 * 等待過久使用者會先察覺不順,過短則會產生衝突。
 */
const SETTLE_MS = 700;

/**
 * 使用者自行捲動後的緩衝期。
 *
 * 使用者回看前幾句時,若每次換句都將畫面拉回,操作手感如同被畫面甩開。
 */
const USER_SCROLL_GRACE_MS = 4000;

let container = null;
let userScrolledAt = 0;

/** 觀察中的行,以及其成為演唱中該行的時點 */
let pendingEl = null;
let pendingAt = 0;
/** 該行已判斷完畢,不再重複判斷 */
let judged = false;

/**
 * 記錄使用者的捲動操作。
 *
 * 刻意不監聽 scroll 事件:此容器有三個捲動來源 —— 使用者、Spotify 與本擴充功能,
 * 而 scroll 事件無從區分來源。監聽該事件會使 Spotify 每次自動捲動皆被視為使用者
 * 操作,自動置中於第一次換句後即永久停擺。wheel、touchmove 與按鍵則僅在實際
 * 操作時觸發。
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
  // 更換容器(換歌、重新開啟歌詞檢視)時不應繼承前一個容器的使用者捲動狀態
  userScrolledAt = 0;
  return container;
}

/**
 * 計算使該行落於焦點所需的捲動距離。
 * 獨立為函式以便脫離瀏覽器測試:輸入兩個矩形,輸出一個數值。
 *
 * @param {{top: number, height: number}} lineBox 該行的位置
 * @param {{top: number, height: number}} viewBox 捲動容器的可視範圍
 * @returns {number} 捲動距離(正值向下)
 */
export function scrollDelta(lineBox, viewBox) {
  const lineCenter = lineBox.top + lineBox.height / 2;
  const focus = viewBox.top + viewBox.height * FOCUS_RATIO;
  return lineCenter - focus;
}

/**
 * 檢查演唱中的句子是否位於畫面中央,否則補足捲動。
 *
 * 呼叫端每 80ms 呼叫一次。換句後先等待 SETTLE_MS 讓 Spotify 自行捲動,
 * 之後僅判斷一次 —— 位置正確即不處理。
 *
 * @param {HTMLElement|null} lineEl 演唱中的行
 */
export function centerActiveLine(lineEl) {
  if (!lineEl) return;

  if (lineEl !== pendingEl) {
    pendingEl = lineEl;
    pendingAt = performance.now();
    judged = false;
    return; // 換句當下不處理,先讓 Spotify 捲動
  }

  if (judged) return;
  const now = performance.now();
  if (now - pendingAt < SETTLE_MS) return;
  judged = true;

  const box = attachTo(lineEl);
  if (!box) return; // 歌詞區塊尚未達到需要捲動的高度

  // 使用者剛操作過,等待其停止一段時間再介入
  if (now - userScrolledAt < USER_SCROLL_GRACE_MS) return;

  const delta = scrollDelta(lineEl.getBoundingClientRect(), box.getBoundingClientRect());
  if (Math.abs(delta) < MIN_MOVE_PX) return; // Spotify 已捲動到位

  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * 換歌或關閉歌詞檢視時清除狀態。
 * 未清除時,若下一首歌的第一句恰為同一個元素(Spotify 會重用 DOM),
 * 會被視為同一行而不捲動。
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
