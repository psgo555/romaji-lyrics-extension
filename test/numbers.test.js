/**
 * numbers.test.js
 * 阿拉伯數字換成漢字數字。
 *
 * 這一步的正確性沒辦法從畫面上看出來 —— 換錯了不會報錯,只會唸錯,
 * 而唸錯的拼音跟唸對的長得一模一樣。所以規則要在這裡釘住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { digitsToKanji } from '../src/content/numbers.js';

test('實際遇到的那一句', () => {
  // Yuuri〈ビリミリオン〉。轉出來曾經是「50 nen o 50 oku de kao」
  assert.equal(digitsToKanji('50年を50億で買おう'), '五十年を五十億で買おう');
});

test('量詞交給辭典:換成漢字就好,不要自己拼假名', () => {
  /*
   * 「一つ」讀 ひとつ 不是 いちつ —— 那是 kuromoji 辭典裡的知識。
   * 這裡只負責把 1 寫成 一,讀音由它決定。
   */
  assert.equal(digitsToKanji('「マインド1つです」'), '「マインド一つです」');
});

test('十百千前面的 1 要省略', () => {
  assert.equal(digitsToKanji('10'), '十'); // 不是 一十
  assert.equal(digitsToKanji('100'), '百');
  assert.equal(digitsToKanji('1000'), '千');
});

test('個位數的 1 要留著', () => {
  assert.equal(digitsToKanji('1'), '一');
  assert.equal(digitsToKanji('11'), '十一');
});

test('中間的 0 不寫,但位數不能跑掉', () => {
  assert.equal(digitsToKanji('105'), '百五');
  assert.equal(digitsToKanji('1005'), '千五');
  assert.equal(digitsToKanji('150'), '百五十');
});

test('四位以上分組', () => {
  assert.equal(digitsToKanji('10000'), '一万'); // 万 前面的一要留
  assert.equal(digitsToKanji('1999'), '千九百九十九'); // 年份
  assert.equal(digitsToKanji('123456'), '十二万三千四百五十六');
});

test('整組是 0 的話連單位都不寫', () => {
  // 一億(不是 一億零万)
  assert.equal(digitsToKanji('100000000'), '一億');
});

test('0 就是零', () => {
  assert.equal(digitsToKanji('0'), '零');
});

/* ----------------------------------------------- 這些刻意不換 */

test('英文字母旁邊的數字不換', () => {
  /*
   * 那是單字的一部分,不是數量。換了會變成「mp三」,
   * 而 kuromoji 會試著把它唸出來 —— 比原樣留著更糟。
   */
  assert.equal(digitsToKanji('mp3'), 'mp3');
  assert.equal(digitsToKanji('Y2K'), 'Y2K');
  assert.equal(digitsToKanji('24k magic'), '24k magic');
});

test('前面補零的不換', () => {
  // 007、03:15 這種是編號或時間,「007」唸成「七」很奇怪
  assert.equal(digitsToKanji('007'), '007');
  assert.equal(digitsToKanji('03'), '03');
});

test('長到不像要唸出來的不換', () => {
  const long = '12345678901234567';
  assert.equal(digitsToKanji(long), long);
});

test('沒有數字時原樣回傳', () => {
  assert.equal(digitsToKanji('人生をやり直したいと'), '人生をやり直したいと');
  assert.equal(digitsToKanji(''), '');
});

test('全形數字也算', () => {
  assert.equal(digitsToKanji('５０年'), '五十年');
});

test('一句裡有好幾個數字都要換', () => {
  assert.equal(digitsToKanji('1人と2人'), '一人と二人');
});
