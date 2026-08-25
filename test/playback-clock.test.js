/**
 * playback-clock.test.js
 * 跳轉目標的夾範圍。
 *
 * 這裡守的是「不要把一個荒謬的值送進進度條」。seekTo 本身是純 DOM 操作,
 * 這個環境沒有 DOM 測不到;但決定「要跳到哪個毫秒」的那段是純算術,
 * 而它正是出錯會被使用者看見的部分 —— 跳到負的或超過歌長,
 * Spotify 的反應無從預期,可能停在奇怪的位置或直接跳下一首。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clampSeekMs } from '../src/content/playback-clock.js';

const DURATION = 274607; // 實測某首 4:34 的歌,進度條回報的精確長度

test('範圍內的值原樣回傳', () => {
  assert.equal(clampSeekMs(91854, DURATION), 91854);
});

test('負數夾到 0', () => {
  // LRC 的第一句有時標得很前面,或使用者把提前量調得很大
  assert.equal(clampSeekMs(-5000, DURATION), 0);
});

test('超過歌長夾到歌長', () => {
  assert.equal(clampSeekMs(999999, DURATION), DURATION);
});

test('兩個邊界值本身不被推開', () => {
  assert.equal(clampSeekMs(0, DURATION), 0);
  assert.equal(clampSeekMs(DURATION, DURATION), DURATION);
});

test('回傳整數 —— 進度條吃的是毫秒,不要留小數', () => {
  assert.equal(clampSeekMs(1234.6, DURATION), 1235);
});

test('歌長不合理時回 null,代表這次不要跳', () => {
  /*
   * 讀不到歌長就無從判斷上限。與其硬跳一個沒把握的位置,不如什麼都不做 ——
   * 使用者再點一次就好,而跳到錯的地方他得自己找回來。
   */
  assert.equal(clampSeekMs(1000, 0), null);
  assert.equal(clampSeekMs(1000, NaN), null);
  assert.equal(clampSeekMs(1000, undefined), null);
  assert.equal(clampSeekMs(1000, -1), null);
});

test('目標本身不是數字時也回 null', () => {
  // 沒有時間軸的行,timeMs 會是 null
  assert.equal(clampSeekMs(null, DURATION), null);
  assert.equal(clampSeekMs(undefined, DURATION), null);
  assert.equal(clampSeekMs(NaN, DURATION), null);
});
