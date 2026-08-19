/**
 * sync-highlight.test.js
 * 把時間軸對到畫面上的行,以及算出「這句唱到幾成」。
 *
 * 這裡有兩個容易壞、而且壞了也不會噴錯的地方:
 * 1. 對齊是照順序貪婪比對的 —— 若改成查表,重複的副歌會全部對到第一次出現的時間
 * 2. fillGaps 最後強制遞增 —— 順序一亂,找「現在第幾句」時會提早停下來略過中間幾句
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignLrc,
  fillGaps,
  activeIndexAt,
  buildWordCurve,
  progressFromCurve,
  progressAt,
} from '../src/content/sync-highlight.js';

/* ------------------------------------------------------------ 對齊 */

test('文字一樣的行要對到對應的時間', () => {
  const lrc = [
    { timeMs: 1000, text: '夢ならば' },
    { timeMs: 2000, text: '未だに' },
  ];
  const { times, matchRate } = alignLrc(lrc, ['夢ならば', '未だに']);
  assert.deepEqual(times, [1000, 2000]);
  assert.equal(matchRate, 1);
});

test('空白與標點的差異不影響比對', () => {
  const lrc = [{ timeMs: 1000, text: '夢ならば、どれほど' }];
  const { times } = alignLrc(lrc, ['夢ならば どれほど']);
  assert.equal(times[0], 1000);
});

test('重複的副歌要照順序對,不可以全部對到第一次', () => {
  // 查表式的實作會在這裡壞掉 —— 兩句一模一樣的副歌會拿到同一個時間
  const lrc = [
    { timeMs: 1000, text: '同じ' },
    { timeMs: 5000, text: '同じ' },
  ];
  const { times } = alignLrc(lrc, ['同じ', '同じ']);
  assert.deepEqual(times, [1000, 5000]);
});

test('對不上的行是 null,而且比例要反映出來', () => {
  const lrc = [{ timeMs: 1000, text: '夢ならば' }];
  const { times, matchRate } = alignLrc(lrc, ['夢ならば', '完全不同的一句']);
  assert.equal(times[0], 1000);
  assert.equal(times[1], null);
  assert.equal(matchRate, 0.5);
});

test('間奏空行不列入比對計算', () => {
  const lrc = [{ timeMs: 1000, text: '夢ならば' }];
  const { matchRate } = alignLrc(lrc, ['夢ならば', '']);
  assert.equal(matchRate, 1); // 空行不算分母
});

test('沒有時間軸時比例是 0,不要丟例外', () => {
  const { times, matchRate } = alignLrc([], ['夢ならば']);
  assert.deepEqual(times, [null]);
  assert.equal(matchRate, 0);
});

/* ------------------------------------------------------------ 補洞 */

test('中間對不到的行用前後內插補起來', () => {
  assert.deepEqual(fillGaps([0, null, 2000]), [0, 1000, 2000]);
});

test('頭尾補不了就留著 null', () => {
  const filled = fillGaps([null, 1000, null]);
  assert.equal(filled[0], null);
  assert.equal(filled[2], null);
});

test('結果一定是遞增的(順序亂掉會害高亮略過中間幾句)', () => {
  const filled = fillGaps([1000, 500, 2000]); // 第二筆比第一筆早
  for (let i = 1; i < filled.length; i += 1) {
    assert.ok(filled[i] >= filled[i - 1], `第 ${i} 筆比前一筆早:${filled}`);
  }
});

/* -------------------------------------------------- 現在唱到第幾句 */

test('回傳最後一個已經開始的句子', () => {
  const times = [0, 1000, 2000];
  assert.equal(activeIndexAt(times, 1500), 1);
  assert.equal(activeIndexAt(times, 2000), 2);
});

test('第一句還沒開始時回 -1', () => {
  assert.equal(activeIndexAt([5000], 1000), -1);
});

/* ------------------------------------------------------ 逐字進度 */

test('逐字折線用字數比例當座標', () => {
  const curve = buildWordCurve([
    { timeMs: 0, text: 'ab' }, // 佔一半
    { timeMs: 1000, text: 'cd' },
  ]);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].frac, 0);
  assert.equal(curve[1].frac, 0.5);
});

test('沒有逐字資料時回 null', () => {
  assert.equal(buildWordCurve(null), null);
  assert.equal(buildWordCurve([]), null);
  assert.equal(buildWordCurve([{ timeMs: 0, text: '' }]), null);
});

test('兩個標籤之間是線性內插,掃描才會連續', () => {
  const curve = [
    { timeMs: 0, frac: 0 },
    { timeMs: 1000, frac: 0.5 },
  ];
  assert.equal(progressFromCurve(curve, 500, 2000), 0.25);
});

test('句子開始前是 0', () => {
  const curve = [{ timeMs: 1000, frac: 0 }];
  assert.equal(progressFromCurve(curve, 0, 2000), 0);
});

test('估算式進度夾在 0 到 1 之間', () => {
  const times = [0, 10000];
  assert.equal(progressAt(times, 0, 0), 0);
  assert.equal(progressAt(times, 0, 5000), 0.5);
  assert.equal(progressAt(times, 0, 99000), 1); // 不可以超過 1
  assert.equal(progressAt(times, -1, 5000), 0); // 索引無效
});

test('maxSpanMs 會封頂,避免句尾接長間奏時掃太慢', () => {
  // 一句唱 2 秒卻隔 20 秒才接下一句,照句距掃會拖到唱完才掃四分之一
  const times = [0, 20000];
  assert.equal(progressAt(times, 0, 2000, { maxSpanMs: 2000 }), 1);
});
