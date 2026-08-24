/**
 * selection-range.js
 * 修正面板選詞器的範圍計算。
 *
 * 獨立為單一模組的原因與 macron.js、drag-bounds.js 相同:不 import 任何項目,
 * 因此可直接以 Node 測試。
 *
 * 置於 correction-popover.js 內則無法測試 —— 該模組會引入 corrections-store.js,
 * 而後者於模組層級呼叫 chrome.storage,在 Node 環境載入即拋出 ReferenceError。
 *
 * 本段邏輯曾兩度出錯,且兩次的症狀皆為點擊無反應。該類錯誤不會被使用者回報為
 * 「規則不正確」,僅會被視為功能故障,因此需以測試固定。
 */

/**
 * 計算點擊後的選取範圍。
 *
 * 規則為「選取至該字為止」;尚未選取任何範圍時,該次點擊決定起點。
 * 選取必須為連續區間,不連續的範圍無法產生有意義的替換結果。
 *
 * 先前的規則為「點擊邊緣向內縮減一格,點擊中間不作用」,存在兩個問題:
 * 逐字點擊至末尾會選取整句,而縮減僅能自尾端逐格進行;點擊中間完全無回饋,
 * 使用者無從得知僅有邊緣可點。
 *
 * @param {{start: number, end: number}} selection 目前範圍(end 不含)
 * @param {number} index 點擊的字序
 * @returns {{start: number, end: number}} 新範圍
 */
export function nextSelection(selection, index) {
  const { start, end } = selection;

  // 尚未選取:該次點擊決定起點,而非自開頭選取至該處。
  // 雙擊開啟的面板預設為空範圍,缺少此條件會使點擊中間變成自開頭選取。
  if (start === end) return { start: index, end: index + 1 };

  // 點擊於起點左側:將起點移至該處
  if (index < start) return { start: index, end };

  // 其餘情況:選取至該字為止
  return { start, end: index + 1 };
}
