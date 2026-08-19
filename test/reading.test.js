/**
 * reading.test.js
 * 使用者輸入的讀音 → 假名。
 *
 * 這一支的存在理由是個使用性問題:補讀音原本只收假名,等於要求
 * 「先知道假名怎麼寫才能修讀音」—— 而知道的人本來就不太需要這個功能。
 * 使用者腦裡有的是羅馬拼音,所以兩種都要收。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toKanaReading, isValidReading } from '../src/content/reading.js';

test('羅馬拼音轉成假名', () => {
  assert.equal(toKanaReading('shinnozou'), 'しんのぞう');
  assert.equal(toKanaReading('enko'), 'えんこ');
  assert.equal(toKanaReading('doyomeki'), 'どよめき');
});

test('分詞用的空白要拿掉', () => {
  // 打羅馬拼音時很自然會分開打,但讀音本身不含空白 ——
  // 留著會讓驗證失敗,而使用者看不出哪裡錯
  assert.equal(toKanaReading('shin no zou'), 'しんのぞう');
  assert.equal(toKanaReading('  futari  '), 'ふたり');
});

test('已經是假名的原樣通過,不會被「修正」', () => {
  assert.equal(toKanaReading('しんのぞう'), 'しんのぞう');
  assert.equal(toKanaReading('えんこ'), 'えんこ');
});

test('促音、撥音、拗音都要對', () => {
  assert.equal(toKanaReading('gakkou'), 'がっこう'); // 促音
  assert.equal(toKanaReading('sennin'), 'せんにん'); // 撥音
  assert.equal(toKanaReading('chotto'), 'ちょっと'); // 拗音 + 促音
  assert.equal(toKanaReading('kanna'), 'かんな');
});

test('空輸入回空字串,不要丟例外', () => {
  assert.equal(toKanaReading(''), '');
  assert.equal(toKanaReading('   '), '');
  assert.equal(toKanaReading(null), '');
  assert.equal(toKanaReading(undefined), '');
});

test('轉不出來的東西原樣留著,交給驗證擋下', () => {
  // 這支只負責轉換,不做驗證 —— 混在一起的話,
  // 「轉不出來」與「轉出來但不合法」就分不開了
  assert.equal(isValidReading(toKanaReading('漢字')), false);
  assert.equal(isValidReading(toKanaReading('123')), false);
});

test('打到一半的輸入不會被當成有效讀音', () => {
  // 每打一個字都會觸發預覽,半成品不可以被當成有效值存進去
  assert.equal(isValidReading(toKanaReading('s')), false);
  assert.equal(isValidReading(toKanaReading('sh')), false);
  assert.equal(isValidReading(toKanaReading('shi')), true); // 打完整才算數
});

test('驗證本身:只收假名與長音符', () => {
  assert.equal(isValidReading('しんのぞう'), true);
  assert.equal(isValidReading('ラーメン'), true); // 片假名與長音符
  assert.equal(isValidReading('心の臓'), false); // 混漢字等於沒修正到
  assert.equal(isValidReading('shin'), false);
  assert.equal(isValidReading(''), false);
  assert.equal(isValidReading(null), false);
});

test('實際案例:心の臓 要整個詞一起補', () => {
  /*
   * RADWIMPS〈すずめ〉的「心の臓」。斷詞把「心」單獨讀成 こころ、
   * 「臓」則完全讀不出來,兩個錯疊在一起 —— 只補「臓」會得到
   * 「kokoro no zou」,前半段還是錯的。
   * 正確做法是三個字一起選,填 shin no zou。
   */
  const reading = toKanaReading('shin no zou');
  assert.equal(reading, 'しんのぞう');
  assert.ok(isValidReading(reading), '轉出來的必須通過假名驗證');
});
