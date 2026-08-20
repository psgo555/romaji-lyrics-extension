/**
 * line-anchor.test.js
 * 換句聽 Spotify 的、句內進度用 LRC 的。
 *
 * 這裡測的是那個取捨的兩個關鍵:選哪一行、以及對錶之後的虛擬位置。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseActive, anchoredPosition, OBSERVED_GRACE_MS } from '../src/content/line-anchor.js';

const memo = () => ({ index: -1, at: 0 });

test('看得到 Spotify 的高亮就聽它的,不聽時間軸', () => {
  /*
   * 這就是整個修正的重點。LRC 說已經第 7 句了、Spotify 還在第 5 句,
   * 聽 LRC 的話拼音會先掃過去,那句日文要再過一兩秒才變白。
   */
  const m = memo();
  assert.equal(chooseActive(5, 7, m, 1000), 5);
});

test('觀察結果會被記下來', () => {
  const m = memo();
  chooseActive(5, 7, m, 1000);
  assert.deepEqual(m, { index: 5, at: 1000 });
});

test('一瞬間認不出來時沿用上一次,不要跳', () => {
  /*
   * Spotify 放大正在唱那一行的動畫進行到一半時,可能有一兩幀分不出來。
   * 那時掉回時間軸的話,高亮會往前跳一兩句再跳回來 —— 比慢一點難看得多。
   */
  const m = memo();
  chooseActive(5, 7, m, 1000);
  assert.equal(chooseActive(-1, 7, m, 1000 + OBSERVED_GRACE_MS - 1), 5);
});

test('久久觀察不到就認輸,改用時間軸', () => {
  // 純拼音模式把原文藏起來,樣式差異也跟著沒了 —— 這時只剩時間軸可用
  const m = memo();
  chooseActive(5, 7, m, 1000);
  assert.equal(chooseActive(-1, 7, m, 1000 + OBSERVED_GRACE_MS + 1), 7);
});

test('從頭到尾都觀察不到就一直用時間軸', () => {
  const m = memo();
  assert.equal(chooseActive(-1, 7, m, 1000), 7);
  assert.equal(chooseActive(-1, 8, m, 2000), 8);
});

test('沿用不會把記錄的時間往後推', () => {
  /*
   * 若沿用時也更新時間戳,寬限期就永遠不會到期 ——
   * Spotify 的高亮真的壞掉時會卡在最後看到的那一行不動。
   */
  const m = memo();
  chooseActive(5, 7, m, 1000);
  chooseActive(-1, 7, m, 1500);
  assert.equal(m.at, 1000);
});

/* --------------------------------------------------- 對錶之後的虛擬位置 */

test('剛換句時,虛擬位置就是這一句的開頭', () => {
  assert.equal(anchoredPosition(30000, 0, 0), 30000);
});

test('虛擬位置只跟「換句後過了多久」有關,跟絕對時間差無關', () => {
  /*
   * 這就是對錶的意義:LRC 的絕對時間偏了兩秒也沒關係,
   * 因為我們只用它的「這一句從哪裡開始」當基準,往後全部自己數。
   */
  assert.equal(anchoredPosition(30000, 1200, 0) - 30000, 1200);
});

test('提前量讓掃描在句子裡跑在前面', () => {
  assert.equal(anchoredPosition(30000, 1000, 500), 31500);
});

test('這一句沒有時間就回 null,讓呼叫端自己決定退路', () => {
  assert.equal(anchoredPosition(null, 1000, 0), null);
  assert.equal(anchoredPosition(undefined, 1000, 0), null);
});

test('時間是 0 的第一句不可以被當成「沒有時間」', () => {
  // 0 是合法的開始時間(歌一開始就唱),用 ?? 而不是 || 才不會踩到
  assert.equal(anchoredPosition(0, 800, 0), 800);
});
