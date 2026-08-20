/**
 * line-anchor.js
 * 讓「換到下一句」這件事跟 Spotify 自己同步。
 *
 * ── 問題 ──────────────────────────────────────────────────────
 * 畫面上同時有兩個高亮:Spotify 自己的(正在唱的那句日文變白、略微放大),
 * 以及我們的(拼音逐字掃過去)。兩邊看的是**不同的時鐘**:
 *
 *   Spotify  照它自己的播放進度,跟音訊完全同步
 *   我們     照 LRCLIB 的時間軸,那是另一份資料、另一次錄音的時間
 *
 * 兩份資料的絕對時間差個一兩秒是常態。使用者看到的就是:拼音已經掃到
 * 下一句了,那句日文卻還沒變白;等 Spotify 追上來,日文才「啪」一下
 * 變白並跳動一下 —— 那個跳動是 Spotify 放大正在唱那一行造成的,
 * 本來是正常的效果,只是時間對不上就顯得像故障。
 *
 * ── 做法 ──────────────────────────────────────────────────────
 * 換句的**時機**改成聽 Spotify 的(它的時鐘才是真的),
 * 句子內部的**進度**仍然用 LRCLIB 的時間軸算。
 *
 * 關鍵在於:LRCLIB 的絕對時間會偏,但「這一句唱多久」是可信的。
 * 所以每次換句就重新對錶一次 —— 絕對誤差不會累積,永遠歸零重來。
 *
 * 實際做法是造一個「虛擬播放位置」:
 *
 *   虛擬位置 = 這一句在 LRC 裡的開始時間 + Spotify 換到這句之後過了多久
 *
 * 這個數字餵給原本的掃描程式,它完全不用知道發生過對錶這件事。
 */

/**
 * 觀察不到 Spotify 高亮時,還能沿用上一次的觀察結果多久。
 *
 * Spotify 放大正在唱那一行的動畫進行到一半時,可能會有一兩幀分不出來
 * 是哪一行(兩行的樣式暫時一樣)。那時候直接掉回 LRC 時間軸的話,
 * 高亮會往前跳一兩句再跳回來 —— 比慢一點難看得多。
 */
export const OBSERVED_GRACE_MS = 2000;

/**
 * 決定這一刻要把哪一行當成「正在唱」。
 *
 * @param {number} observed 從畫面上觀察到的(Spotify 自己的高亮),-1 代表看不出來
 * @param {number} timeline 照 LRC 時間軸算出來的,當退路用
 * @param {{index: number, at: number}} memo 上一次成功觀察到的結果,會被就地更新
 * @param {number} now performance.now()
 * @returns {number} 行的索引,-1 代表兩邊都給不出答案
 */
export function chooseActive(observed, timeline, memo, now) {
  if (observed >= 0) {
    memo.index = observed;
    memo.at = now;
    return observed;
  }

  // 剛才還看得到,只是這一瞬間認不出來 —— 沿用,不要跳
  if (memo.index >= 0 && now - memo.at < OBSERVED_GRACE_MS) return memo.index;

  // 真的觀察不到了(例如純拼音模式把原文藏起來,樣式差異也跟著沒了)
  return timeline;
}

/**
 * 算出餵給掃描程式的「虛擬播放位置」。
 *
 * @param {number|null} lineStartMs 這一句在 LRC 時間軸上的開始時間
 * @param {number} sinceChangeMs Spotify 換到這一句之後過了多久
 * @param {number} offsetMs 使用者設的提前量(正值 = 提早)
 * @returns {number|null} 虛擬位置;沒有這一句的時間時回 null
 */
export function anchoredPosition(lineStartMs, sinceChangeMs, offsetMs) {
  if (lineStartMs === null || lineStartMs === undefined) return null;
  return lineStartMs + sinceChangeMs + offsetMs;
}
