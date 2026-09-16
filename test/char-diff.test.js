/**
 * char-diff.test.js
 * Myers 字元對應。
 *
 * 重點有三:對應到的字數必須等於最長共同子序列(對應不可漏)、對應必須遞增
 * (時間軸才不會前後顛倒)、提前放棄不可誤殺達標的輸入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { matchMap, toCodes } from '../src/content/char-diff.js';

/** 對照用的最長共同子序列長度(小字串用,O(n·m) 無妨) */
function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

const run = (x, y, options) => matchMap(toCodes(x), toCodes(y), options);

test('完全相同:每個字元都對應到同一個位置', () => {
  const { map, matched } = run('きみのこと', 'きみのこと');
  assert.equal(matched, 5);
  assert.deepEqual([...map], [0, 1, 2, 3, 4]);
});

test('對應到的字數等於最長共同子序列', () => {
  const pairs = [
    ['ふたりだけのそら', 'ふたりだけのそらがひろがる'],
    ['きみのこころ', 'ぼくのこころ'],
    ['abcdefg', 'acdfg'],
    ['', 'あいう'],
    ['あいう', ''],
  ];
  for (const [a, b] of pairs) {
    const { matched } = run(a, b);
    assert.equal(matched, lcsLength([...a], [...b]), `${a} / ${b}`);
  }
});

test('對應必為遞增(時間軸不會前後顛倒)', () => {
  const { map } = run('あいうえおかきくけこ', 'あXいうZえおかきくけこ');
  let last = -1;
  for (const value of map) {
    if (value < 0) continue;
    assert.ok(value > last, `對應沒有遞增:${[...map]}`);
    last = value;
  }
});

test('對不到的字元回 -1,不會亂配', () => {
  const { map } = run('あXい', 'あい');
  assert.deepEqual([...map], [0, -1, 1]);
});

test('完全沒有共同字元:matched 為 0', () => {
  const { matched, aborted } = run('あいう', 'xyz');
  assert.equal(matched, 0);
  assert.equal(aborted, false);
});

test('以碼位比對,表情符號不會被拆成兩半', () => {
  // 代理對若被當成兩個單位處理,會出現只對到半個字元的結果
  const { map, matched } = run('あ🎵い', 'あ🎵い');
  assert.equal(matched, 3);
  assert.deepEqual([...map], [0, 1, 2]);
});

/* ------------------------------------------------- 提前放棄 */

test('達得到門檻的輸入不會被放棄,且結果與不設門檻時相同', () => {
  const a = 'ふたりだけのそらがひろがるよるに';
  const b = 'ふたりだけのそらがひろがる夜に';
  const full = run(a, b);
  const cut = run(a, b, { minRatio: 0.8 });
  assert.equal(cut.aborted, false);
  assert.equal(cut.matched, full.matched);
  assert.deepEqual([...cut.map], [...full.map]);
});

test('差太多即提前放棄,map 為 null', () => {
  const cut = run('ゆめならばどれほどよかったでしょう', 'yumenarabadorehodoyokattadeshou', { minRatio: 0.8 });
  assert.equal(cut.aborted, true);
  assert.equal(cut.map, null);
});

test('b 比門檻所需的字數還短時立即放棄', () => {
  const cut = run('あいうえおかきくけこ', 'あい', { minRatio: 0.8 });
  assert.equal(cut.aborted, true);
});

test('門檻未給定時一律完整計算', () => {
  const { aborted, matched } = run('あいうえお', 'xyz');
  assert.equal(aborted, false);
  assert.equal(matched, 0);
});
