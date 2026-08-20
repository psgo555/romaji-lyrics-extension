/**
 * notice.js
 * 在畫面角落講一句話,然後自己消失。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────
 * 有些歌沒有逐字時間資料,拼音就不會跟著歌聲一個字一個字亮。
 * 那是**正常的**(資料就是沒有),但畫面上看起來跟壞掉一模一樣 ——
 * 而且設定裡的「延遲校正」滑桿在那種歌上怎麼拖都沒反應,
 * 使用者只會覺得這個擴充功能時好時壞。
 *
 * 講一句話的成本很低,誤會的成本很高。
 *
 * ── 為什麼是會自己消失的小框,不是常駐的狀態列 ────────────────
 * 這件事只在**換歌的那一刻**有資訊量:知道了就知道了,之後每一秒都
 * 還掛在那裡只是擋畫面。常駐的東西也會讓人以為是錯誤警告。
 */

const CLASS = 'romaji-notice';

/** 講完話停留多久。兩行中文讀完大約要這麼久,再久就變成擋路的了。 */
const VISIBLE_MS = 8000;

let el = null;
let hideTimer = null;

/**
 * 顯示一則提示。同時只會有一則 —— 後來的蓋掉先前的。
 *
 * @param {string} title 一句話講完是什麼情況
 * @param {string} body 補充:什麼還能用、什麼不能用
 */
export function showNotice(title, body) {
  hideNotice();

  el = document.createElement('div');
  el.className = CLASS;
  // 螢幕報讀軟體要唸出來,但不要打斷使用者正在做的事
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const titleEl = document.createElement('div');
  titleEl.className = 'romaji-notice-title';
  titleEl.textContent = title;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'romaji-notice-body';
  bodyEl.textContent = body;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'romaji-notice-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '關閉提示');
  close.addEventListener('click', hideNotice);

  el.append(titleEl, bodyEl, close);
  document.body.append(el);

  hideTimer = setTimeout(hideNotice, VISIBLE_MS);
}

export function hideNotice() {
  clearTimeout(hideTimer);
  hideTimer = null;
  el?.remove();
  el = null;
}
