/**
 * settings.test.js
 * 設定值的正規化與模式循環。
 *
 * 這裡專測不碰儲存的那幾支。getSettings / setSetting 要瀏覽器環境,
 * 不在這一層測 —— 但它們讀進來之後也是交給這些函式把關,
 * 所以認不得的舊值會不會安全退回預設,這裡測得到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  DISPLAY_MODES,
  normalizeMode,
  normalizeOffset,
  normalizeSweepMs,
  nextMode,
  describeMode,
  isConversionOff,
  conversionKind,
  SYNC_OFFSET_MIN,
  SYNC_OFFSET_MAX,
  SWEEP_MS_MIN,
  SWEEP_MS_MAX,
} from '../src/shared/settings.js';

test('認得的模式原樣返回', () => {
  for (const mode of DISPLAY_MODES) {
    assert.equal(normalizeMode(mode.value), mode.value);
  }
});

test('認不得的舊值退回預設', () => {
  // 早期版本用過 'below' / 'above'
  assert.equal(normalizeMode('below'), DEFAULTS.displayMode);
  assert.equal(normalizeMode(undefined), DEFAULTS.displayMode);
  assert.equal(normalizeMode(null), DEFAULTS.displayMode);
});

test('模式循環會走完全部四個再回到起點', () => {
  // 註解一度寫成三個(漏了後來加的 kana),這裡用實際數量把關
  const seen = [];
  let mode = DEFAULTS.displayMode;
  for (let i = 0; i < DISPLAY_MODES.length; i += 1) {
    seen.push(mode);
    mode = nextMode(mode);
  }
  assert.equal(mode, DEFAULTS.displayMode, '繞一圈要回到起點');
  assert.equal(new Set(seen).size, DISPLAY_MODES.length, '每個模式都要出現一次');
});

test('提前量夾在合理範圍內', () => {
  assert.equal(normalizeOffset(99999), SYNC_OFFSET_MAX);
  assert.equal(normalizeOffset(-99999), SYNC_OFFSET_MIN);
  assert.equal(normalizeOffset(900), 900);
});

test('提前量認不得的值退回預設', () => {
  assert.equal(normalizeOffset('abc'), DEFAULTS.syncOffsetMs);
  assert.equal(normalizeOffset(undefined), DEFAULTS.syncOffsetMs);
});

test('提前量一律取整數', () => {
  assert.equal(normalizeOffset(900.7), 901);
  assert.ok(Number.isInteger(normalizeOffset('123.4')));
});

test('掃描速度夾在合理範圍內', () => {
  assert.equal(normalizeSweepMs(9999), SWEEP_MS_MAX);
  assert.equal(normalizeSweepMs(0), SWEEP_MS_MIN);
  assert.equal(normalizeSweepMs('abc'), DEFAULTS.sweepMsPerLetter);
});

test('只有 off 代表關閉轉換', () => {
  assert.equal(isConversionOff('off'), true);
  assert.equal(isConversionOff('romaji-only'), false);
  assert.equal(isConversionOff('kana'), false);
});

test('拼音的兩種顯示方式屬於同一種轉換', () => {
  // 這是「切顯示方式不必重跑斷詞」的依據 —— 弄錯會讓整頁卡住好幾秒
  assert.equal(conversionKind('romaji-only'), conversionKind('both'));
  assert.equal(conversionKind('romaji-only'), 'romaji');
});

test('假名是另一種轉換,不能跟拼音混為一談', () => {
  assert.equal(conversionKind('kana'), 'kana');
  assert.notEqual(conversionKind('kana'), conversionKind('both'));
});

test('關閉時不做任何轉換', () => {
  assert.equal(conversionKind('off'), null);
});

test('每個模式都有顯示用的文字', () => {
  for (const mode of DISPLAY_MODES) {
    const info = describeMode(mode.value);
    assert.ok(info.label, `${mode.value} 少了 label`);
    assert.ok(info.hint, `${mode.value} 少了 hint`);
    assert.ok(info.short, `${mode.value} 少了 short`);
  }
});

test('預設值本身要是合法的', () => {
  assert.equal(normalizeMode(DEFAULTS.displayMode), DEFAULTS.displayMode);
  assert.equal(normalizeOffset(DEFAULTS.syncOffsetMs), DEFAULTS.syncOffsetMs);
  assert.equal(normalizeSweepMs(DEFAULTS.sweepMsPerLetter), DEFAULTS.sweepMsPerLetter);
});
