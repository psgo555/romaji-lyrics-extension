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
  describeOffset,
  normalizeSweepMs,
  nextMode,
  describeMode,
  isConversionOff,
  conversionKind,
  SYNC_OFFSET_MIN,
  SYNC_OFFSET_MAX,
  SWEEP_MS_MIN,
  SWEEP_MS_MAX,
  normalizeColor,
  normalizeScale,
  ROMAJI_SCALE_MIN,
  ROMAJI_SCALE_MAX,
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

test('提前量顯示成秒,不要讓使用者讀毫秒', () => {
  assert.equal(describeOffset(900), '提早 0.9 秒');
  assert.equal(describeOffset(-400), '延後 0.4 秒');
  assert.equal(describeOffset(0), '不調整');
});

test('提前量顯示:整數秒不要拖著沒意義的零', () => {
  assert.equal(describeOffset(2000), '提早 2 秒'); // 不是「2.00 秒」
  assert.equal(describeOffset(-500), '延後 0.5 秒'); // 不是「0.50 秒」
});

test('提前量顯示:最小刻度也要看得懂', () => {
  // 滑桿一格是 50ms,顯示成 0.05 秒
  assert.equal(describeOffset(50), '提早 0.05 秒');
});

test('提前量顯示:壞掉的值不會顯示成 NaN', () => {
  // 使用者不該看到「提早 NaN 秒」
  assert.ok(!describeOffset('abc').includes('NaN'));
  assert.ok(!describeOffset(undefined).includes('NaN'));
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
    assert.ok(info.label, `${mode.value} 少了 label`); // popup 的選項文字
    assert.ok(info.short, `${mode.value} 少了 short`); // 頁面上那顆小按鈕的字
  }
});

test('預設值本身要是合法的', () => {
  assert.equal(normalizeMode(DEFAULTS.displayMode), DEFAULTS.displayMode);
  assert.equal(normalizeOffset(DEFAULTS.syncOffsetMs), DEFAULTS.syncOffsetMs);
  assert.equal(normalizeSweepMs(DEFAULTS.sweepMsPerLetter), DEFAULTS.sweepMsPerLetter);
});

/* ------------------------------------------------- 拼音外觀 */

test('顏色只接受六位十六進位色碼', () => {
  assert.equal(normalizeColor('#ff6b9d'), '#ff6b9d');
  assert.equal(normalizeColor('#FF6B9D'), '#ff6b9d'); // 大小寫統一
});

test('顏色:認不得的一律退回預設', () => {
  /*
   * 這道檢查不是形式上的 —— 這個值會被寫進頁面的 CSS 變數,
   * 而設定是跨裝置同步的。放行任意字串等於讓外部資料影響頁面樣式。
   */
  for (const bad of ['red', '#fff', '#12345', 'rgb(1,2,3)', 'red; content:x', '', null, 123]) {
    assert.equal(
      normalizeColor(bad),
      DEFAULTS.romajiColor,
      `${JSON.stringify(bad)} 應該被擋下`
    );
  }
});

test('大小夾在合理範圍內', () => {
  assert.equal(normalizeScale(9999), ROMAJI_SCALE_MAX);
  assert.equal(normalizeScale(0), ROMAJI_SCALE_MIN);
  assert.equal(normalizeScale(80), 80);
  assert.equal(normalizeScale('abc'), DEFAULTS.romajiScale);
});

test('外觀的預設值本身要合法', () => {
  assert.equal(normalizeColor(DEFAULTS.romajiColor), DEFAULTS.romajiColor);
  assert.equal(normalizeScale(DEFAULTS.romajiScale), DEFAULTS.romajiScale);
});
