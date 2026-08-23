/**
 * drag-bounds.test.js
 * 拖曳之後面板落在哪裡。
 *
 * 這裡真正要守的只有一件事:**面板永遠抓得回來**。
 * 標題列是唯一能拖的地方,它一旦跑到畫面外,滑鼠就再也點不到,
 * 使用者只能重新整理頁面 —— 而他不會知道要那樣做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clampToViewport } from '../src/content/drag-bounds.js';

const panel = { width: 360, height: 500 };
const screen = { width: 1280, height: 800 };

test('畫面內的位置不動它', () => {
  assert.deepEqual(clampToViewport({ left: 400, top: 200 }, panel, screen), {
    left: 400,
    top: 200,
  });
});

test('拖出右邊會被拉回來', () => {
  // 1280 - 360 - 8 = 912
  assert.equal(clampToViewport({ left: 5000, top: 200 }, panel, screen).left, 912);
});

test('拖出上面會被拉回來 —— 這條最重要', () => {
  /*
   * 往上拖出去最容易發生也最致命:標題列在面板頂端,
   * 它一超出畫面就完全沒辦法再抓到面板了。
   */
  assert.equal(clampToViewport({ left: 400, top: -500 }, panel, screen).top, 8);
});

test('拖出左邊、下面也一樣', () => {
  assert.equal(clampToViewport({ left: -900, top: 200 }, panel, screen).left, 8);
  assert.equal(clampToViewport({ left: 400, top: 5000 }, panel, screen).top, 292); // 800-500-8
});

test('面板比視窗還大時靠左上角,不要算出負的', () => {
  /*
   * 視窗被縮到很小的時候,「右邊界減面板寬」會是負數。
   * 直接用那個值的話面板會被推到畫面外,連標題列都不見。
   */
  const tiny = { width: 300, height: 200 };
  assert.deepEqual(clampToViewport({ left: 100, top: 100 }, panel, tiny), { left: 8, top: 8 });
});

test('邊界值剛好貼齊時不要被多推一格', () => {
  const result = clampToViewport({ left: 912, top: 292 }, panel, screen);
  assert.deepEqual(result, { left: 912, top: 292 });
});

test('回傳整數,不要留下半個像素', () => {
  // 帶小數的 left 會讓文字在某些縮放比例下糊掉
  const result = clampToViewport({ left: 400.6, top: 200.4 }, panel, screen);
  assert.ok(Number.isInteger(result.left));
  assert.ok(Number.isInteger(result.top));
});
