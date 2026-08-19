/**
 * lrc.test.js
 * 歌詞時間軸解析。
 *
 * 小數位數的換算是這種格式最常被寫錯的地方:
 * 兩位是百分之一秒、三位是千分之一秒。搞混會讓整首歌的高亮偏掉十倍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLrc, findLineAt, lineProgress } from '../src/content/lrc.js';

test('基本的時間標籤換算成毫秒', () => {
  const { lines } = parseLrc('[00:12.34] 夢ならば');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].timeMs, 12340); // 12 秒 + 34/100 秒
  assert.equal(lines[0].text, '夢ならば');
});

test('小數兩位是百分之一秒、三位是千分之一秒', () => {
  assert.equal(parseLrc('[00:00.05] a').lines[0].timeMs, 50);
  assert.equal(parseLrc('[00:00.005] a').lines[0].timeMs, 5);
});

test('分鐘要乘進去', () => {
  assert.equal(parseLrc('[02:03.00] a').lines[0].timeMs, 123000);
});

test('沒有小數也要能解析', () => {
  assert.equal(parseLrc('[01:30] a').lines[0].timeMs, 90000);
});

test('同一行掛多個時間標籤要展開成多句(重複的副歌)', () => {
  const { lines } = parseLrc('[00:10.00][01:20.00] 同一句副歌');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].timeMs, 10000);
  assert.equal(lines[1].timeMs, 80000);
  assert.equal(lines[0].text, lines[1].text);
});

test('結果一定是按時間排好的', () => {
  const { lines } = parseLrc('[00:30.00] 後面\n[00:10.00] 前面');
  const times = lines.map((l) => l.timeMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('純說明行(作者、標題)不算歌詞', () => {
  const { lines } = parseLrc('[ar:米津玄師]\n[ti:Lemon]\n[00:12.00] 真的歌詞');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '真的歌詞');
});

test('只有時間沒有文字的間奏行要保留', () => {
  // 拿掉的話高亮會一直卡在上一句
  const { lines } = parseLrc('[00:10.00] 有字\n[00:20.00]');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, '');
});

test('逐字時間標籤要抽出來,而且不留在文字裡', () => {
  const { lines } = parseLrc('[00:10.00] <00:10.00>夢<00:11.00>ならば');
  assert.equal(lines[0].text, '夢ならば');
  assert.equal(lines[0].words.length, 2);
  assert.equal(lines[0].words[0].text, '夢');
  assert.equal(lines[0].words[1].timeMs, 11000);
});

test('沒有逐字標籤時不該有 words 欄位', () => {
  assert.equal(parseLrc('[00:10.00] 夢ならば').lines[0].words, undefined);
});

test('offset 標籤是從時間戳減掉', () => {
  const { lines, offsetMs } = parseLrc('[offset:500]\n[00:10.00] a');
  assert.equal(offsetMs, 500);
  assert.equal(lines[0].timeMs, 9500);
});

test('時間不會被 offset 減成負數', () => {
  assert.equal(parseLrc('[offset:5000]\n[00:01.00] a').lines[0].timeMs, 0);
});

test('壞掉或空的輸入回空陣列,不要丟例外', () => {
  assert.deepEqual(parseLrc('').lines, []);
  assert.deepEqual(parseLrc(null).lines, []);
  assert.deepEqual(parseLrc('完全沒有時間標籤的一段文字').lines, []);
});

test('BOM 與 Windows 換行不影響解析', () => {
  const { lines } = parseLrc('﻿[00:10.00] a\r\n[00:20.00] b');
  assert.equal(lines.length, 2);
});

test('findLineAt 回傳最後一個已經開始的句子', () => {
  const lines = [{ timeMs: 0 }, { timeMs: 10000 }, { timeMs: 20000 }];
  assert.equal(findLineAt(lines, 15000), 1);
  assert.equal(findLineAt(lines, 20000), 2); // 剛好等於起始時間算已開始
  assert.equal(findLineAt(lines, 99000), 2);
});

test('findLineAt 在第一句還沒開始時回 -1', () => {
  assert.equal(findLineAt([{ timeMs: 5000 }], 1000), -1);
});

test('lineProgress 夾在 0 到 1 之間', () => {
  const lines = [{ timeMs: 0 }, { timeMs: 10000 }];
  assert.equal(lineProgress(lines, 0, 0), 0);
  assert.equal(lineProgress(lines, 0, 5000), 0.5);
  assert.equal(lineProgress(lines, 0, 10000), 1);
  assert.equal(lineProgress(lines, 0, 99000), 1); // 不可以超過 1
  assert.equal(lineProgress(lines, -1, 5000), 0); // 索引無效
});
