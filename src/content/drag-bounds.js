/**
 * drag-bounds.js
 * 拖曳之後,面板該落在哪裡。
 *
 * ── 這段唯一的責任:不要讓面板跑到抓不回來的地方 ────────────────
 * 拖到畫面外面本身不會出錯,但使用者會**失去把它拉回來的方法** ——
 * 標題列(唯一能抓的地方)一旦超出畫面,滑鼠就再也點不到它了。
 * 那種狀態只能靠重新整理頁面解除,而使用者不會知道要那樣做。
 *
 * 所以夾住的重點不是「好看」,是**永遠留一條路回來**。
 *
 * 不 import 任何東西,所以 Node 測得到。
 */

/**
 * 把位置夾在畫面內。
 *
 * @param {{left: number, top: number}} pos 想放的位置
 * @param {{width: number, height: number}} size 面板大小
 * @param {{width: number, height: number}} viewport 視窗大小
 * @param {number} [margin] 邊緣至少留多少
 * @returns {{left: number, top: number}}
 */
export function clampToViewport(pos, size, viewport, margin = 8) {
  /*
   * 面板比畫面還大時(視窗被縮得很小),maxLeft 會小於 margin。
   * 那時一律靠左上角 —— 至少標題列在畫面裡,抓得到。
   */
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);

  return {
    left: Math.round(Math.min(Math.max(pos.left, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(pos.top, margin), maxTop)),
  };
}
