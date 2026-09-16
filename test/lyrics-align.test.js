/**
 * lyrics-align.test.js
 * 以字元對應把 LRC 時間軸套到畫面上的歌詞行。
 *
 * 測資的形態取自實測(2026-09):斷行差異是兩個方向都有的,
 * 而且同一首歌的用字也可能略有出入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { alignByChars, MIN_MATCH_RATIO } from '../src/content/lyrics-align.js';

const lrc = (...pairs) => pairs.map(([timeMs, text]) => ({ timeMs, text }));

test('斷行一致:每一行直接取得該句的時間', () => {
  const lines = ['沈むように溶けてゆくように', '二人だけの空が広がる夜に'];
  const result = alignByChars(lines, lrc([1000, '沈むように溶けてゆくように'], [5000, '二人だけの空が広がる夜に']));
  assert.deepEqual(result.times, [1000, 5000]);
  assert.equal(result.aborted, false);
  assert.equal(result.coverage, 1);
  assert.equal(result.anchored, 1);
});

test('畫面把 LRC 的兩句併成一行(Pretender):取第一句的時間', () => {
  const result = alignByChars(
    ['君とのラブストーリー それは予想通り', 'いざ始まればひとり芝居だ'],
    lrc([1000, '君とのラブストーリー'], [3000, 'それは予想通り'], [6000, 'いざ始まればひとり芝居だ'])
  );
  assert.deepEqual(result.times, [1000, 6000]);
});

test('LRC 把畫面的兩行併成一句(粉雪):第二行依字元比例內插', () => {
  /*
   * 「風に吹かれて似たように凍えるのに」共 16 字,第二行自第 6 字開始。
   * 該句 46000,下一句 59000,內插得 46000 + 13000 × 6/16 = 50875。
   * 直接取 46000 會使兩行同時亮起。
   */
  const result = alignByChars(
    ['風に吹かれて', '似たように凍えるのに', '僕は君の全てなど'],
    lrc([46000, '風に吹かれて似たように凍えるのに'], [59000, '僕は君の全てなど知ってはいないだろう'])
  );
  assert.deepEqual(result.times, [46000, 50875, 59000]);
});

test('空白與標點的差異不影響對齊', () => {
  const result = alignByChars(
    ['「さよなら」だけだった'],
    lrc([2000, 'さよなら だけだった'])
  );
  assert.deepEqual(result.times, [2000]);
});

test('用字略有出入仍對得起來(粉雪:事/こと、返/かえ)', () => {
  const result = alignByChars(
    ['二人の孤独を分け合う事が出来たのかい', 'それでも僕は君のこと守り続けたい'],
    lrc([1000, '二人の孤独を分け合うことができたのかい'], [9000, 'それでも僕は君の事を守り続けたい'])
  );
  assert.deepEqual(result.times, [1000, 9000]);
  assert.ok(result.coverage > 0.8, `相符度偏低:${result.coverage}`);
});

test('畫面多出的和聲對不到時該行留 null,不猜測', () => {
  const result = alignByChars(
    ['些細な言い合いもなくて', 'ラライラライ', '同じ時間を生きてなどいけない'],
    lrc([1000, '些細な言い合いもなくて'], [5000, '同じ時間を生きてなどいけない'])
  );
  assert.deepEqual(result.times, [1000, null, 5000]);
  assert.ok(result.anchored < 1);
});

test('挑錯版本(羅馬拼音版)即放棄,不套用任何時間', () => {
  const result = alignByChars(
    ['夢ならばどれほどよかったでしょう', '未だにあなたのことを夢にみる'],
    lrc([1000, 'Yume naraba dore hodo yokatta deshou'], [5000, 'Imada ni anata no koto wo yume ni miru'])
  );
  assert.equal(result.aborted, true);
  assert.deepEqual(result.times, [null, null]);
  assert.equal(result.coverage, 0);
});

test('LRC 的間奏行(有時間、無文字)不參與比對', () => {
  const result = alignByChars(
    ['一行目', '二行目'],
    lrc([1000, '一行目'], [3000, ''], [5000, '二行目'])
  );
  assert.deepEqual(result.times, [1000, 5000]);
});

test('最後一句落在句中時以固定長度推算,不會超出太多', () => {
  const result = alignByChars(['前半です', '後半です'], lrc([10000, '前半です後半です']));
  assert.equal(result.times[0], 10000);
  assert.ok(result.times[1] > 10000 && result.times[1] <= 14000, `內插超出範圍:${result.times[1]}`);
});

test('沒有歌詞行或沒有時間軸時回傳放棄', () => {
  assert.equal(alignByChars([], lrc([1000, 'あ'])).aborted, true);
  assert.equal(alignByChars(['あ'], []).aborted, true);
  assert.equal(alignByChars(['あ'], null).aborted, true);
});

test('門檻可調,且預設為 0.8', () => {
  assert.equal(MIN_MATCH_RATIO, 0.8);
  const lines = ['あいうえおかきくけこ'];
  const timeline = lrc([1000, 'あいうえお']);
  assert.equal(alignByChars(lines, timeline).aborted, true);
  assert.equal(alignByChars(lines, timeline, { minRatio: 0.4 }).aborted, false);
});
