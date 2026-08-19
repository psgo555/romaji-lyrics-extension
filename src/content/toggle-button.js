/**
 * toggle-button.js
 * 在 Spotify 播放列的「歌詞」按鈕旁邊插入一顆切換鈕,
 * 點一下就依序循環 displayMode:
 * romaji-only → both → kana → off → romaji-only。
 *
 * (順序以 settings.js 的 DISPLAY_MODES 為準,這裡只是說明 ——
 *  先前這行漏掉了後來才加的 kana,列成三個而實際有四個。)
 *
 * 同步機制:按鈕不自己記狀態,而是寫進 chrome.storage.sync(跟 popup 同一份設定),
 * 再由 storage.onChanged 回頭更新按鈕外觀。所以頁面按鈕與 popup 單選鈕
 * 永遠是同一個真相來源,兩邊都會即時反映對方的變更。
 *
 * 生命週期:Spotify 是 SPA,播放列會被 React 重建。
 * 這裡不自己開 observer,而是由 index.js 每秒的 tick() 呼叫 syncToggleButton(),
 * 錨點消失就把按鈕收掉,錨點回來就重新插入。
 */

import { describeMode, nextMode } from '../shared/settings.js';

const BUTTON_CLASS = 'romaji-toggle';
const ANCHOR_SELECTOR = '[data-testid="lyrics-button"]';

let buttonEl = null;
let onCycleHandler = null;

/** 依目前模式更新按鈕文字與 tooltip */
export function renderToggleButton(mode) {
  if (!buttonEl) return;

  const current = describeMode(mode);
  const upcoming = describeMode(nextMode(mode));

  buttonEl.textContent = current.short;
  buttonEl.dataset.romajiToggle = current.value;

  const description = `羅馬拼音:${current.label}(${current.hint})\n點一下切換到:${upcoming.label}`;
  buttonEl.title = description;
  buttonEl.setAttribute('aria-label', description);
}

function createButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  // 不要讓點擊冒泡到 Spotify 自己的播放列控制項
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCycleHandler?.();
  });
  return button;
}

/**
 * 確保按鈕在正確位置。每秒被呼叫一次,所以要能便宜地重複執行。
 * @param {() => string} getMode 目前的 displayMode
 * @param {() => void} onCycle 點擊時要跑的切換邏輯
 */
export function syncToggleButton(getMode, onCycle) {
  onCycleHandler = onCycle;

  const anchor = document.querySelector(ANCHOR_SELECTOR);

  // 歌詞按鈕不在(沒在播放、或 Spotify 還沒渲染完)→ 收掉自己的按鈕,下次再等
  if (!anchor) {
    buttonEl?.remove();
    buttonEl = null;
    return;
  }

  // 已經在正確的位置就什麼都不用做
  if (buttonEl?.isConnected && buttonEl.previousElementSibling === anchor) return;

  // React 重建播放列時我們的按鈕會被丟掉或錯位,重新插一顆
  buttonEl?.remove();
  buttonEl = createButton();
  anchor.insertAdjacentElement('afterend', buttonEl);
  renderToggleButton(getMode());
}
