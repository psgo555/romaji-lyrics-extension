/**
 * cjk.test.js
 * 日文字元判定,以及「哪幾個字沒轉出來」的偵測。
 *
 * 這套判定同時決定了三件事:哪一行要送去轉換、哪幾個字要標紅讓使用者補讀音、
 * 以及歌詞版本挑選時算日文比例。判定放寬或縮緊都會同時影響這三處。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasJapanese,
  findUnromanized,
  findUnreadKanji,
  toLetterRanges,
  isIterationMarkOnly,
} from '../src/content/cjk.js';

test('平假名、片假名、漢字都算日文', () => {
  assert.ok(hasJapanese('ひらがな'));
  assert.ok(hasJapanese('カタカナ'));
  assert.ok(hasJapanese('漢字'));
});

test('疊字符與半形片假名也算(舊版判定漏掉過)', () => {
  assert.ok(hasJapanese('人々'));
  assert.ok(hasJapanese('〆'));
  assert.ok(hasJapanese('ｱｲｳ'));
});

test('純英數不算日文', () => {
  assert.equal(hasJapanese('hello world'), false);
  assert.equal(hasJapanese('12345'), false);
  assert.equal(hasJapanese(''), false);
});

test('找出沒轉出來的日文', () => {
  const runs = findUnromanized('kimi no 怨子 wa');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, '怨子');
});

test('相鄰的字要併成同一段(它們是同一個詞的原文)', () => {
  const runs = findUnromanized('a 漢字熟語 b');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, '漢字熟語');
});

test('分開的兩段要各自成段', () => {
  const runs = findUnromanized('a 怨 b 子 c');
  assert.equal(runs.length, 2);
});

test('全部轉出來時回空陣列', () => {
  assert.deepEqual(findUnromanized('kimi no koto wa'), []);
  assert.deepEqual(findUnromanized(''), []);
});

test('假名模式下只有漢字才算沒讀出來', () => {
  // 假名模式的輸出本來就整片是假名,那些不是錯誤
  assert.deepEqual(findUnreadKanji('ゆめならば'), []);
  const runs = findUnreadKanji('ゆめ怨子ならば');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, '怨子');
});

test('字串位置要換算成字母索引(空白被拿掉了)', () => {
  // 畫面上每個字母是一個元素,而那些元素是把空白拿掉後逐字產生的,
  // 所以字串位置跟元素索引之間差了被拿掉的空白數
  const romaji = 'a b 怨子';
  const runs = findUnromanized(romaji);
  const ranges = toLetterRanges(romaji, runs);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, 2); // 'a','b' 之後
  assert.equal(ranges[0].end, 4);
  assert.equal(ranges[0].text, '怨子');
});

test('沒有範圍時 toLetterRanges 回空陣列', () => {
  assert.deepEqual(toLetterRanges('abc', []), []);
  assert.deepEqual(toLetterRanges('abc', null), []);
});

/* ------------------------------------------------- 疊字符 */

test('疊字符單獨出現時要被認出來', () => {
  // 它讀什麼取決於前一個字,不能單獨補讀音
  assert.equal(isIterationMarkOnly('々'), true);
  assert.equal(isIterationMarkOnly('ゝ'), true);
  assert.equal(isIterationMarkOnly('ヾ'), true);
  assert.equal(isIterationMarkOnly('〃'), true);
});

test('疊字符跟前面的字一起選就是有效的範圍', () => {
  assert.equal(isIterationMarkOnly('時々'), false);
  assert.equal(isIterationMarkOnly('人々'), false);
  assert.equal(isIterationMarkOnly('時時々'), false);
});

test('一般文字不是疊字符', () => {
  assert.equal(isIterationMarkOnly('漢字'), false);
  assert.equal(isIterationMarkOnly(''), false);
  assert.equal(isIterationMarkOnly(null), false);
});
