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
  SWEEP_SPEED_MIN,
  SWEEP_SPEED_MAX,
  normalizeSweepSpeed,
  applySweepSpeed,
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

test('0.5 秒為單位的加減不會衝出範圍', () => {
  /*
   * popup 那兩顆按鈕的行為就是「目前值 ± 500 再正規化」。
   * 這裡把那個算式測起來,重點是**到邊界要停住** ——
   * 連按到底時若沒夾住,會存進超出範圍的值,而高亮會整個跑掉。
   */
  const nudge = (current, delta) => normalizeOffset(Number(current) + delta);

  assert.equal(nudge(900, -500), 400);
  assert.equal(nudge(900, 500), 1400);

  // 已經在邊界上再按,要停在原地
  assert.equal(nudge(SYNC_OFFSET_MIN, -500), SYNC_OFFSET_MIN);
  assert.equal(nudge(SYNC_OFFSET_MAX, 500), SYNC_OFFSET_MAX);

  // 快到邊界時要被夾住,不可以溢出
  assert.equal(nudge(-300, -500), SYNC_OFFSET_MIN);
  assert.equal(nudge(1800, 500), SYNC_OFFSET_MAX);
});

test('掃描快慢:100% 不改變進度', () => {
  assert.equal(applySweepSpeed(0.5, 100), 0.5);
  assert.equal(applySweepSpeed(0, 100), 0);
  assert.equal(applySweepSpeed(1, 100), 1);
});

test('掃描快慢:調快會提早掃完,調慢會拖長', () => {
  assert.equal(applySweepSpeed(0.5, 200), 1); // 快一倍 → 半路就掃完
  assert.equal(applySweepSpeed(0.5, 50), 0.25); // 慢一半
});

test('掃描快慢:結果一定夾在 0~1,不可以衝出這一行', () => {
  assert.equal(applySweepSpeed(0.9, 200), 1);
  assert.ok(applySweepSpeed(0.99, 200) <= 1);
  assert.ok(applySweepSpeed(0.01, 50) >= 0);
});

test('掃描快慢:沒有進度時保持沒有(不要假裝有資料)', () => {
  assert.equal(applySweepSpeed(null, 150), null);
});

test('掃描快慢:認不得的值退回預設,而且範圍會夾住', () => {
  assert.equal(normalizeSweepSpeed('abc'), DEFAULTS.sweepSpeed);
  assert.equal(normalizeSweepSpeed(9999), SWEEP_SPEED_MAX);
  assert.equal(normalizeSweepSpeed(0), SWEEP_SPEED_MIN);
  // 壞掉的設定不可以讓進度變成 NaN —— 那會讓整行高亮消失
  assert.ok(Number.isFinite(applySweepSpeed(0.5, 'abc')));
});

test('掃描快慢:每一段調整都要真的改變結果(這正是加這個設定的原因)', () => {
  /*
   * 先前的 sweepMsPerLetter 只在「沒有逐字時間軸」的歌上有效,
   * 有逐字資料的歌完全不理會 —— 使用者拉滑桿畫面一動也不動。
   * 這個倍率是套在最後算好的進度上的,所以任何情況下調了都必須有反應。
   */
  const progress = 0.4;
  const seen = new Set();
  for (const speed of [50, 75, 100, 125, 150]) {
    seen.add(applySweepSpeed(progress, speed));
  }
  assert.equal(seen.size, 5, '不同的倍率必須算出不同的結果');
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
