/**
 * toggle-button.js
 * 於 Spotify 播放列的歌詞按鈕旁插入切換鈕,點擊即依序循環 displayMode。
 *
 * 循環順序以 settings.js 的 DISPLAY_MODES 為準。
 *
 * 按鈕不自行保存狀態,而是寫入 chrome.storage.sync,再由 storage.onChanged 更新外觀。
 * 頁面按鈕與 popup 選項因而共用同一份設定,任一端的變更會即時反映於另一端。
 *
 * Spotify 為 SPA,播放列會被 React 重建。本模組不自行建立 observer,而由 index.js
 * 每秒的 tick() 呼叫 syncToggleButton():錨點消失時移除按鈕,錨點出現時重新插入。
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

  // label 已含完整描述(「原文 + 下方羅馬拼音」),無須額外補述
  const description = `羅馬拼音:${current.label}\n點一下切換到:${upcoming.label}`;
  buttonEl.title = description;
  buttonEl.setAttribute('aria-label', description);
}

function createButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  // 避免點擊冒泡至 Spotify 自身的播放列控制項
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCycleHandler?.();
  });
  return button;
}

/**
 * 確保按鈕位於正確位置。每秒呼叫一次,重複執行的成本須維持低廉。
 * @param {() => string} getMode 目前的 displayMode
 * @param {() => void} onCycle 點擊時執行的切換邏輯
 */
export function syncToggleButton(getMode, onCycle) {
  onCycleHandler = onCycle;

  const anchor = document.querySelector(ANCHOR_SELECTOR);

  // 歌詞按鈕不存在(未播放,或 Spotify 尚未完成渲染):移除按鈕,待下次檢查
  if (!anchor) {
    buttonEl?.remove();
    buttonEl = null;
    return;
  }

  // 位置正確,無須處理
  if (buttonEl?.isConnected && buttonEl.previousElementSibling === anchor) return;

  // React 重建播放列時按鈕會遺失或錯位,重新插入
  buttonEl?.remove();
  buttonEl = createButton();
  anchor.insertAdjacentElement('afterend', buttonEl);
  renderToggleButton(getMode());
}
