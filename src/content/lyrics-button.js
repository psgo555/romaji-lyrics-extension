/**
 * lyrics-button.js
 * Spotify 播放列「歌詞」按鈕的狀態判讀。純函式,不 import 任何項目。
 *
 * 按鈕有三種可區分的狀態(實測 2026-09):
 *
 * | 狀態 | disabled | aria-pressed | aria-label(僅供參考,隨語系變動) |
 * |---|---|---|---|
 * | 有歌詞、檢視未開啟 | false | "false" | 歌詞 |
 * | 有歌詞、檢視已開啟 | false | "true"  | 歌詞 |
 * | Spotify 無此曲目歌詞 | true | "false" | 我們好像沒有這首歌曲的歌詞。 |
 *
 * 第三種狀態下檢視根本打不開 —— 按鈕為 HTML disabled,瀏覽器不會送出 click。
 * 原先的判斷只看 aria-pressed,把它與「使用者沒有開啟檢視」混為一談,
 * 備援因而永遠不會觸發;開啟中的面板亦會被當成「檢視已關閉」而立即收起。
 *
 * 判讀一律以 disabled 屬性為準,不讀 aria-label:後者是給人看的文字,隨語系改變。
 */

/**
 * 讀取按鈕狀態。
 *
 * @param {Element|null} button
 * @returns {{ exists: boolean, unavailable: boolean, pressed: string|null }}
 *   unavailable:Spotify 標示此曲目無歌詞(按鈕為 disabled)
 *   pressed:aria-pressed(舊版為 data-active)的原始值,無此屬性時為 null
 */
export function readLyricsButton(button) {
  if (!button) return { exists: false, unavailable: false, pressed: null };
  return {
    exists: true,
    unavailable: button.disabled === true || button.hasAttribute('disabled'),
    pressed: button.getAttribute('aria-pressed') ?? button.getAttribute('data-active'),
  };
}

/**
 * 依按鈕判斷歌詞檢視是否開啟。
 *
 * @returns {boolean|null} 無法由按鈕判斷(找不到按鈕,或沒有狀態屬性)時回 null,由呼叫端決定退路
 */
export function lyricsViewOpenFromButton(state) {
  if (!state.exists || state.pressed === null) return null;
  return state.pressed === 'true';
}

/**
 * 歌詞檢視是否「確定是使用者關閉的」。
 *
 * 用於決定是否收起 LRCLIB 面板 —— 猜錯的代價是把使用者正在看的內容弄不見,
 * 故只認可明確的否定。按鈕為 disabled 時不算:那不是使用者關閉了檢視,
 * 而是 Spotify 沒有歌詞可顯示,面板正是為此而開。
 */
export function isLyricsViewClosedByUser(state) {
  return state.exists && !state.unavailable && state.pressed === 'false';
}

/**
 * 這一下按壓是否落在「Spotify 標示為無歌詞」的歌詞按鈕上。
 *
 * 以座標比對按鈕範圍,而非看事件的 target:按鈕若另設 pointer-events:none,
 * 事件會落在其下方的元素上,target 便不是按鈕(實測 Chrome 152)。
 *
 * @param {{ exists: boolean, unavailable: boolean }} state
 * @param {{ left: number, right: number, top: number, bottom: number }|null} rect 按鈕的 getBoundingClientRect()
 * @param {number} x 事件的 clientX
 * @param {number} y 事件的 clientY
 */
export function isPressOnUnavailableButton(state, rect, x, y) {
  if (!state.exists || !state.unavailable || !rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
