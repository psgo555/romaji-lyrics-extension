/**
 * selection-range.js
 * 修正面板裡「點一下之後選取範圍變成什麼」的規則。
 *
 * ── 為什麼獨立成一支 ──────────────────────────────────────
 * 跟 macron.js、reading.js 同一個理由:**不 import 任何東西**,
 * 所以 Node 可以直接載進來測。
 *
 * 放回 correction-popover.js 的話就測不到了 —— 那支會拉進
 * corrections-store.js,而它在 module 層就呼叫 chrome.storage,
 * 在 Node 裡一載入就 ReferenceError。(實際踩到才搬出來的。)
 *
 * 而這段邏輯很需要測:它已經出過兩次錯,兩次的症狀都是**點下去沒反應**,
 * 使用者只會覺得壞掉,不會回報「規則不對」。
 */

/**
 * 點某個字之後,範圍應該變成什麼。
 *
 * ── 規則只有一條:點一下就是「選到這個字為止」──────────────
 * (還沒選任何東西時例外,那一下是決定起點。)
 *
 * 選取必須是連續的一段 —— 中間有洞的話取代出來的結果沒有意義。
 *
 * ── 為什麼把原本的規則整個換掉 ──────────────────────────────
 * 原本是「點邊緣往內縮一格,點中間不做事」。那有兩個問題:
 *
 * 1. 一路點到最後一個字會整句都選起來,而要退回去只能從尾巴
 *    一個字一個字縮 —— 十四個字就要點十三下。
 * 2. 點中間**完全沒有反應**。使用者會以為壞了,而不會意識到
 *    「原來只有邊緣可以點」。沒有回饋的操作等於沒有這個操作。
 *
 * 新規則下,選過頭時點回想要的那個字就到位了,一下解決。
 * 要往左延伸就點開頭左邊的字,要自由選一段就用拖的。
 *
 * @param {{start: number, end: number}} selection 目前的範圍(end 不含)
 * @param {number} index 點到第幾個字
 * @returns {{start: number, end: number}} 新的範圍
 */
export function nextSelection(selection, index) {
  const { start, end } = selection;

  // 還沒選任何東西:這一下是決定起點,不是「從頭選到這裡」。
  // 雙擊進來的面板預設就是空的,少了這一條會變成「點中間卻從頭選起」。
  if (start === end) return { start: index, end: index + 1 };

  // 點在開頭左邊 → 把開頭移過去
  if (index < start) return { start: index, end };

  // 其餘一律是「選到這個字為止」
  return { start, end: index + 1 };
}
