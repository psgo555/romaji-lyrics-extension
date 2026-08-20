/**
 * auto-scroll.test.js
 * 換句時要把正在唱的那一句捲到畫面中間。
 *
 * 只測算距離那一步 —— 那是這個功能唯一會算錯的地方。
 * 捲動本身要有瀏覽器,不在這一層測。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { scrollDelta } from '../src/content/auto-scroll.js';

/** 容器佔滿一個 600px 高的視窗 */
const view = { top: 0, height: 600 };

test('已經在正中間的行不需要捲動', () => {
  // 高 60 的行,中心在 300 = 容器中心
  assert.equal(scrollDelta({ top: 270, height: 60 }, view), 0);
});

test('行在下面時要往下捲(正值)', () => {
  /*
   * 這就是使用者回報的情況:高亮跳到下一句了,但那一句還在畫面下緣。
   * 中心在 480,離焦點 300 差 180,所以要往下捲 180。
   */
  assert.equal(scrollDelta({ top: 450, height: 60 }, view), 180);
});

test('行在上面時要往上捲(負值)', () => {
  assert.equal(scrollDelta({ top: 70, height: 60 }, view), -200);
});

test('用行的中心算,不是行的上緣', () => {
  /*
   * 加了拼音之後每一行大約高兩倍。若拿上緣去對齊,行越高就越偏下,
   * 「有拼音的歌」跟「純英文那幾行」會停在不一樣的位置。
   */
  const short = scrollDelta({ top: 400, height: 40 }, view);
  const tall = scrollDelta({ top: 380, height: 80 }, view); // 同一個中心 420
  assert.equal(short, tall);
});

test('容器不是從視窗頂端開始也要算對', () => {
  // 歌詞區塊上面有導覽列時,容器的 top 不是 0
  const offsetView = { top: 100, height: 400 }; // 焦點在 300
  assert.equal(scrollDelta({ top: 270, height: 60 }, offsetView), 0);
});
