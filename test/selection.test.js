/**
 * selection.test.js
 * 修正面板裡的選詞器:點一下之後範圍要變成什麼。
 *
 * 為什麼這段值得測:它已經出過兩次錯,而且錯的方式都是**沒有反應** ——
 * 點下去什麼都沒發生,使用者只會覺得壞掉,不會回報「規則不對」。
 * 這種錯不會自己浮出來,只能靠測試釘住。
 *
 * 範圍用 { start, end },end 不含。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nextSelection } from '../src/content/selection-range.js';

test('還沒選任何東西時,這一下決定起點', () => {
  /*
   * 雙擊進來的面板預設是空的。少了這一條會變成「點中間卻從頭選起」——
   * 想修第四個字,結果前四個字全被選起來。
   */
  assert.deepEqual(nextSelection({ start: 0, end: 0 }, 3), { start: 3, end: 4 });
});

test('點右邊的字 → 延伸到那裡', () => {
  assert.deepEqual(nextSelection({ start: 0, end: 1 }, 3), { start: 0, end: 4 });
});

test('點左邊的字 → 開頭移過去,結尾不動', () => {
  assert.deepEqual(nextSelection({ start: 3, end: 5 }, 1), { start: 1, end: 5 });
});

test('選過頭時點回去,一下就縮到位', () => {
  /*
   * 這就是這次要修的:原本只能從尾巴一個字一個字縮,
   * 十四個字的句子選過頭要點十三下。
   */
  assert.deepEqual(nextSelection({ start: 0, end: 14 }, 1), { start: 0, end: 2 });
});

test('點在範圍中間要有反應', () => {
  // 原本點中間完全不做事 —— 沒有回饋的操作等於沒有這個操作
  const before = { start: 0, end: 10 };
  assert.notDeepEqual(nextSelection(before, 4), before);
  assert.deepEqual(nextSelection(before, 4), { start: 0, end: 5 });
});

test('點開頭那個字 → 只剩它一個', () => {
  assert.deepEqual(nextSelection({ start: 0, end: 14 }, 0), { start: 0, end: 1 });
});

test('點目前的結尾 → 維持原樣,不要少一個', () => {
  // 「選到這個字為止」對已經是結尾的字來說就是不變,不能理解成往內縮
  assert.deepEqual(nextSelection({ start: 2, end: 5 }, 4), { start: 2, end: 5 });
});

test('結果永遠是一段連續且非空的範圍', () => {
  const cases = [
    [{ start: 0, end: 0 }, 0],
    [{ start: 0, end: 0 }, 7],
    [{ start: 0, end: 14 }, 0],
    [{ start: 0, end: 14 }, 13],
    [{ start: 5, end: 6 }, 0],
    [{ start: 5, end: 6 }, 13],
  ];
  for (const [selection, index] of cases) {
    const next = nextSelection(selection, index);
    assert.ok(next.end > next.start, `${JSON.stringify(selection)} 點 ${index} 之後變成空範圍`);
  }
});
