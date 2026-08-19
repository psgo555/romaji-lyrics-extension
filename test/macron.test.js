/**
 * macron.test.js
 * 長音符處理。
 *
 * 這一支的重點是**長度不變**這個性質。macron.js 的註解特別強調過它,
 * 因為 splitter.js 沿用舊切分資料的正確性完全建立在它上面:
 * 切點存的是字母索引,長度一變索引就會落在錯的位置,
 * 使用者存好的空格會整批插到錯的地方 —— 而且不會噴任何錯誤。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripMacrons } from '../src/content/macron.js';

test('五個母音的長音符都要拿掉', () => {
  assert.equal(stripMacrons('ā'), 'a');
  assert.equal(stripMacrons('ī'), 'i');
  assert.equal(stripMacrons('ū'), 'u');
  assert.equal(stripMacrons('ē'), 'e');
  assert.equal(stripMacrons('ō'), 'o');
});

test('大寫也要處理', () => {
  assert.equal(stripMacrons('Ā Ō'), 'A O');
});

test('長度不變(splitter 沿用舊切分的前提)', () => {
  // 這個性質一旦被破壞,使用者存好的手動切分會整批插到錯的位置,
  // 而且不會有任何錯誤訊息 —— 只會覺得「我的設定莫名其妙跑掉了」。
  for (const input of ['kizamō', 'ōkī', 'sukitootta', 'tōkyō', '']) {
    assert.equal(
      stripMacrons(input).length,
      input.length,
      `長度變了:${JSON.stringify(input)}`
    );
  }
});

test('沒有長音符的字串原樣返回', () => {
  assert.equal(stripMacrons('sukitootta'), 'sukitootta');
  assert.equal(stripMacrons(''), '');
});

test('不會誤傷其他重音符號', () => {
  // 只該拿掉長音符,其他附加符號不干我們的事
  assert.equal(stripMacrons('é'), 'é');
  assert.equal(stripMacrons('ñ'), 'ñ');
});

test('日文與拼音混在一起時只動拼音', () => {
  assert.equal(stripMacrons('二人 kizamō'), '二人 kizamo');
});
