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

import { stripMacrons, stripProlongMarks } from '../src/content/macron.js';

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

/* ------------------------------------------------- 長音記號 ー */

test('拿掉原樣掉出來的長音記號', () => {
  /*
   * 字典不認識的詞(擬聲詞、造詞)會退回逐字處理,而 ー 不是假名、
   * 對不到羅馬字就原樣掉出來。實測 RADWIMPS〈ひゅるりらぱっぱ〉:
   *   ひゅるひゅるりーらら → hi yuruhyururi ー ra ra
   */
  assert.equal(stripProlongMarks('hi yuruhyururi ー ra ra'), 'hi yuruhyururi ra ra');
  assert.equal(stripProlongMarks('atchi yu ー ma toki'), 'atchi yu ma toki');
});

test('黏在字尾的長音記號也要拿掉', () => {
  assert.equal(stripProlongMarks('hi yururirappaー'), 'hi yururirappa');
  assert.equal(stripProlongMarks('hi yururirappa ー'), 'hi yururirappa');
});

test('拿掉之後不可以留下連續空白或前後空白', () => {
  // 留著的話會多出沒意義的切分點,畫面上也會看到怪怪的空隙
  assert.ok(!stripProlongMarks('a ー b').includes('  '));
  assert.equal(stripProlongMarks('ー abc'), 'abc');
  assert.equal(stripProlongMarks('abc ー'), 'abc');
});

test('沒有長音記號的字串原樣返回', () => {
  assert.equal(stripProlongMarks('sukitootta'), 'sukitootta');
  assert.equal(stripProlongMarks(''), '');
});

test('這支跟 stripMacrons 是兩件事,不可以合併', () => {
  /*
   * stripMacrons 必須維持字串長度(手動切分的索引靠它),
   * 這支則一定會縮短。合併成一支就會把那個保證一起破壞掉。
   */
  const withMacron = 'kizamō';
  assert.equal(stripMacrons(withMacron).length, withMacron.length, 'stripMacrons 長度不可變');

  const withProlong = 'rappaー';
  assert.ok(stripProlongMarks(withProlong).length < withProlong.length, 'stripProlongMarks 會縮短');
});
