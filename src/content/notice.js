/**
 * notice.js
 * 於畫面角落顯示暫時性提示。
 *
 * 部分曲目沒有逐字時間資料,拼音因而不會逐字高亮。該狀態屬正常結果,
 * 但畫面表現與故障相近,且設定中的提前量滑桿在此類曲目上不會產生任何效果。
 * 缺少說明時,使用者的結論會是本擴充功能運作不穩定。
 *
 * 採自動消失的浮動框而非常駐狀態列:該資訊僅在換曲當下有意義,
 * 之後持續顯示只會遮蔽畫面,且常駐元素容易被誤解為錯誤警告。
 */

const CLASS = 'romaji-notice';

/** 顯示時間。約為兩行中文的閱讀時間,再長會形成干擾。 */
const VISIBLE_MS = 8000;

let el = null;
let hideTimer = null;

/**
 * 顯示提示。同時僅存在一則,後者取代前者。
 *
 * @param {string} title 情況描述
 * @param {string} body 補充說明:何者仍可使用、何者不會作用
 */
export function showNotice(title, body) {
  hideNotice();

  el = document.createElement('div');
  el.className = CLASS;
  // 螢幕報讀軟體須讀出,但不應中斷使用者當前的操作
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
