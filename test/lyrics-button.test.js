/**
 * lyrics-button.test.js
 * Spotify「歌詞」按鈕的狀態判讀。
 *
 * 測資的屬性組合取自實測(2026-09):
 *   紅蓮華(有歌詞)      disabled=false、aria-pressed 隨檢視開關
 *   ホログラム / Muray(無歌詞)disabled=true、aria-pressed="false",點擊收不到 click
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readLyricsButton,
  lyricsViewOpenFromButton,
  isLyricsViewClosedByUser,
  isPressOnUnavailableButton,
} from '../src/content/lyrics-button.js';

/** 模擬按鈕元素:只實作被讀取到的三個成員 */
function fakeButton({ disabled = false, attrs = {} } = {}) {
  return {
    disabled,
    hasAttribute: (name) => name in attrs || (name === 'disabled' && disabled),
    getAttribute: (name) => attrs[name] ?? null,
  };
}

const withLyricsClosed = fakeButton({ attrs: { 'aria-pressed': 'false', 'aria-label': '歌詞' } });
const withLyricsOpen = fakeButton({ attrs: { 'aria-pressed': 'true', 'aria-label': '歌詞' } });
const noLyrics = fakeButton({
  disabled: true,
  attrs: { 'aria-pressed': 'false', 'aria-label': '我們好像沒有這首歌曲的歌詞。' },
});

test('找不到按鈕:無法判斷,交由呼叫端退路', () => {
  const state = readLyricsButton(null);
  assert.equal(state.exists, false);
  assert.equal(lyricsViewOpenFromButton(state), null);
  assert.equal(isLyricsViewClosedByUser(state), false);
});

test('有歌詞、檢視未開啟:未開啟,且確定是使用者沒開', () => {
  const state = readLyricsButton(withLyricsClosed);
  assert.equal(state.unavailable, false);
  assert.equal(lyricsViewOpenFromButton(state), false);
  assert.equal(isLyricsViewClosedByUser(state), true);
});

test('有歌詞、檢視已開啟', () => {
  const state = readLyricsButton(withLyricsOpen);
  assert.equal(lyricsViewOpenFromButton(state), true);
  assert.equal(isLyricsViewClosedByUser(state), false);
});

test('Spotify 無歌詞(disabled):標示為無歌詞,且不算使用者關閉了檢視', () => {
  /*
   * 第二個斷言是這次修正的重點之一:原先只看 aria-pressed="false",
   * 會判定「使用者關閉了檢視」而把剛開啟的 LRCLIB 面板在下一秒收起。
   */
  const state = readLyricsButton(noLyrics);
  assert.equal(state.unavailable, true);
  assert.equal(isLyricsViewClosedByUser(state), false);
  assert.equal(lyricsViewOpenFromButton(state), false);
});

test('非 button 元素只帶 disabled 屬性時同樣視為無歌詞', () => {
  const div = { disabled: undefined, hasAttribute: (n) => n === 'disabled', getAttribute: () => null };
  assert.equal(readLyricsButton(div).unavailable, true);
});

test('舊版以 data-active 表示開啟狀態', () => {
  const legacy = fakeButton({ attrs: { 'data-active': 'true' } });
  assert.equal(lyricsViewOpenFromButton(readLyricsButton(legacy)), true);
});

test('沒有任何狀態屬性:無法由按鈕判斷', () => {
  const bare = fakeButton();
  assert.equal(lyricsViewOpenFromButton(readLyricsButton(bare)), null);
  assert.equal(isLyricsViewClosedByUser(readLyricsButton(bare)), false);
});

const rect = { left: 100, right: 132, top: 50, bottom: 82 };

test('按壓落在無歌詞按鈕範圍內(含邊界)才算', () => {
  const state = readLyricsButton(noLyrics);
  assert.equal(isPressOnUnavailableButton(state, rect, 116, 66), true);
  assert.equal(isPressOnUnavailableButton(state, rect, 100, 50), true);
  assert.equal(isPressOnUnavailableButton(state, rect, 132, 82), true);
  assert.equal(isPressOnUnavailableButton(state, rect, 99, 66), false);
  assert.equal(isPressOnUnavailableButton(state, rect, 116, 83), false);
});

test('按在有歌詞的按鈕上不觸發(那一下交給 Spotify 自己開檢視)', () => {
  assert.equal(isPressOnUnavailableButton(readLyricsButton(withLyricsClosed), rect, 116, 66), false);
});

test('找不到按鈕或取不到位置時不觸發', () => {
  assert.equal(isPressOnUnavailableButton(readLyricsButton(null), rect, 116, 66), false);
  assert.equal(isPressOnUnavailableButton(readLyricsButton(noLyrics), null, 116, 66), false);
});
