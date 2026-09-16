/**
 * ytmusic-clock.test.js
 * YouTube Music 播放進度的純函式部分。
 *
 * 讀取 `<video>` 要有瀏覽器,不在這一層測;能測的是兩個判斷:
 * 數值防呆,以及「現在播的是廣告還是歌曲」。
 *
 * class 的測資取自實測(2026-09,夜に駆ける 播放前的廣告)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { positionMsFrom, isAdClassName } from '../src/content/ytmusic-clock.js';

test('秒轉毫秒,四捨五入', () => {
  assert.equal(positionMsFrom(0), 0);
  assert.equal(positionMsFrom(12.3456), 12346);
  assert.equal(positionMsFrom(261), 261000);
});

test('不可用的數值一律回 null(換曲瞬間會出現)', () => {
  // 換曲時 currentTime 與 duration 會短暫為 NaN,那時不該據以計算高亮
  for (const bad of [NaN, Infinity, -1, undefined, null, '12', {}]) {
    assert.equal(positionMsFrom(bad), null, `應為 null:${String(bad)}`);
  }
});

/* ------------------------------------------------- 廣告判定 */

const AD = 'html5-video-player ytp-hide-controls ad-created ad-showing ad-interrupting playing-mode';
const SONG = 'html5-video-player ytp-hide-controls ad-created ytp-fit-cover-video playing-mode';

test('廣告期間的 class 判定為廣告', () => {
  assert.equal(isAdClassName(AD), true);
  assert.equal(isAdClassName('player ad-showing'), true);
  assert.equal(isAdClassName('player ad-interrupting'), true);
});

test('ad-created 不算廣告', () => {
  /*
   * 這一項是重點:ad-created 代表「本次工作階段曾播過廣告」,歌曲播放時仍然留著。
   * 若放寬為 /ad-/,播過一次廣告之後整首歌都會被判定為廣告,高亮永遠不會出現。
   */
  assert.equal(isAdClassName(SONG), false);
  assert.equal(isAdClassName('ad-created'), false);
});

test('不會把含有 ad 字樣的其他 class 誤判', () => {
  assert.equal(isAdClassName('loaded'), false);
  assert.equal(isAdClassName('ytp-ad-overlay-container'), false);
  assert.equal(isAdClassName('download-showing'), false);
});

test('沒有 class 或取不到時判定為否', () => {
  assert.equal(isAdClassName(''), false);
  assert.equal(isAdClassName(null), false);
  assert.equal(isAdClassName(undefined), false);
});
