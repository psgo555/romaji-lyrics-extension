/**
 * drag-bounds.js
 * 將面板位置夾在可視範圍內。
 *
 * 標題列是唯一的拖曳把手,若超出畫面即無法再以滑鼠選取,只能重新整理頁面。
 * 因此夾制的目的是可回復性,而非版面美觀。
 *
 * 本模組不相依任何其他模組,可直接以 Node 測試。
 */

/**
 * 將位置夾在可視範圍內。
 *
 * @param {{left: number, top: number}} pos 目標位置
 * @param {{width: number, height: number}} size 面板尺寸
 * @param {{width: number, height: number}} viewport 可視範圍尺寸
 * @param {number} [margin] 邊緣保留距離
 * @returns {{left: number, top: number}} 夾制後的整數座標
 */
export function clampToViewport(pos, size, viewport, margin = 8) {
  // 面板大於可視範圍時上限會小於下限,取兩者較大值使面板貼齊左上角
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);

  return {
    left: Math.round(Math.min(Math.max(pos.left, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(pos.top, margin), maxTop)),
  };
}
