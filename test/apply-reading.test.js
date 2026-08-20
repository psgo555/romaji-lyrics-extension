/**
 * apply-reading.test.js
 * 把 issue 的內容收進字典的那條路。
 *
 * 為什麼要測:這支在 CI 上跑,而它會**直接 commit 到 master**。
 * 出錯的話不是某個人的畫面壞掉,是字典檔壞掉、所有使用者一起受影響,
 * 而且發生在沒有人盯著的時候。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIssueBody, applyReading, survivesValidation } from '../tools/apply-reading.mjs';

/** 擴充功能實際送出來的樣子 */
const BODY = [
  '<!-- 這是自動填好的,確認沒問題就直接送出 -->',
  '',
  '- 曲名:Crazy Rainbow (第284-325話 OP)',
  '- 原文:`堕天使`',
  '- 讀音:`だてんし`',
  '- 這一句:僕ら堕天使夢に矢を放つのさ Darling Darling',
  '',
  '這筆修正**只會套用在上面那首歌**,不影響其他歌。',
].join('\n');

const emptyDict = () => ({ version: 1, updatedAt: '2026-01-01', entries: [], songs: [] });

test('讀得出擴充功能送出來的欄位', () => {
  const parsed = parseIssueBody(BODY);
  assert.equal(parsed.song, 'Crazy Rainbow (第284-325話 OP)');
  assert.equal(parsed.surface, '堕天使'); // 反引號要剝掉
  assert.equal(parsed.reading, 'だてんし');
  assert.equal(parsed.line, '僕ら堕天使夢に矢を放つのさ Darling Darling');
});

test('半形冒號與多餘空白也讀得出來', () => {
  // 使用者送出前可以編輯內文,多打一個空格不該讓整條路失敗
  const parsed = parseIssueBody('-  原文 :  `熄み`  \n- 讀音: やみ');
  assert.equal(parsed.surface, '熄み');
  assert.equal(parsed.reading, 'やみ');
});

test('抓不到曲名時的佔位字不算曲名', () => {
  // 「(請補上)」是擴充功能填的,拿它當曲名會生出一組沒有意義的條目
  assert.equal(parseIssueBody('- 曲名:(請補上)').song, '');
  assert.equal(parseIssueBody('- 曲名:（請補上）').song, '');
});

test('格式被改壞時回空字串,不要猜', () => {
  const parsed = parseIssueBody('我想補一個讀音,堕天使唸だてんし');
  assert.equal(parsed.surface, '');
  assert.equal(parsed.reading, '');
});

/* ------------------------------------------------------------ 寫進字典 */

test('限定單曲:收進對應的曲名底下', () => {
  const dict = emptyDict();
  const result = applyReading(dict, {
    surface: '堕天使',
    reading: 'だてんし',
    song: 'Crazy Rainbow',
    scope: 'song',
  });

  assert.equal(result.ok, true);
  assert.equal(dict.songs[0].title, 'Crazy Rainbow');
  assert.deepEqual(dict.songs[0].entries[0], { surface: '堕天使', reading: 'だてんし' });
  assert.equal(dict.entries.length, 0, '不該同時寫進通用層');
});

test('同一首歌的第二筆要併進同一組,不是再開一組', () => {
  const dict = emptyDict();
  const base = { song: 'Crazy Rainbow', scope: 'song' };
  applyReading(dict, { ...base, surface: '堕天使', reading: 'だてんし' });
  applyReading(dict, { ...base, surface: '熄み', reading: 'やみ' });

  assert.equal(dict.songs.length, 1);
  assert.equal(dict.songs[0].entries.length, 2);
});

test('曲名的大小寫與空白差異視為同一首', () => {
  // 比對規則要跟擴充功能查表時完全一致,不然收進去的查不到
  const dict = emptyDict();
  applyReading(dict, {
    surface: '堕天使',
    reading: 'だてんし',
    song: 'Crazy Rainbow',
    scope: 'song',
  });
  applyReading(dict, {
    surface: '熄み',
    reading: 'やみ',
    song: '  crazy   rainbow ',
    scope: 'song',
  });

  assert.equal(dict.songs.length, 1);
});

test('同一個原文再報一次是覆蓋,不是多一筆', () => {
  const dict = emptyDict();
  const base = { surface: '堕天使', song: 'x', scope: 'song' };
  applyReading(dict, { ...base, reading: 'だてんし' });
  const second = applyReading(dict, { ...base, reading: 'だてんつかい' });

  assert.equal(dict.songs[0].entries.length, 1);
  assert.equal(dict.songs[0].entries[0].reading, 'だてんつかい');
  assert.match(second.action, /覆蓋/);
});

test('通用條目寫進 entries', () => {
  const dict = emptyDict();
  applyReading(dict, { surface: '堕天使', reading: 'だてんし', scope: 'global' });

  assert.deepEqual(dict.entries[0], { surface: '堕天使', reading: 'だてんし' });
  assert.equal(dict.songs.length, 0);
});

test('限定單曲卻沒有曲名 → 不收,並說明原因', () => {
  const dict = emptyDict();
  const result = applyReading(dict, { surface: '堕天使', reading: 'だてんし', scope: 'song' });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('曲名'));
  assert.deepEqual(dict.songs, [], '失敗時不可以留下半筆資料');
});

test('缺原文或讀音 → 不收', () => {
  const dict = emptyDict();
  assert.equal(applyReading(dict, { reading: 'やみ', scope: 'global' }).ok, false);
  assert.equal(applyReading(dict, { surface: '熄み', scope: 'global' }).ok, false);
  assert.equal(dict.entries.length, 0);
});

test('出處會寫進 note', () => {
  // dictionary.json 的「★ 有實例才收 ★」要求留下出處,日後才查證得了
  const dict = emptyDict();
  applyReading(dict, {
    surface: '堕天使',
    reading: 'だてんし',
    note: 'Crazy Rainbow — 僕ら堕天使…',
    scope: 'global',
  });
  assert.match(dict.entries[0].note, /Crazy Rainbow/);
});

test('收下之後 updatedAt 要跟著換', () => {
  const dict = emptyDict();
  applyReading(dict, { surface: '堕天使', reading: 'だてんし', scope: 'global' });
  assert.notEqual(dict.updatedAt, '2026-01-01');
  assert.match(dict.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

/* -------------------------------------------------- 用真正的驗證器覆核 */

test('寫得進檔案、卻會被擴充功能丟掉的,要驗得出來', () => {
  /*
   * 這是整支最重要的一條。「只有一個々」寫進 JSON 完全合法,
   * commit 也會成功 —— 然後在每個使用者的瀏覽器裡被默默丟掉,
   * 一路上不會有任何錯誤訊息。所以寫檔前要用同一個驗證器覆核。
   */
  const entry = { surface: '々', reading: 'どき', song: 'x', scope: 'song' };
  const dict = emptyDict();
  applyReading(dict, entry);

  assert.equal(survivesValidation(dict, entry), false);
});

test('正常的一筆通得過覆核', () => {
  const entry = { surface: '堕天使', reading: 'だてんし', song: 'Crazy Rainbow', scope: 'song' };
  const dict = emptyDict();
  applyReading(dict, entry);

  assert.equal(survivesValidation(dict, entry), true);
});

test('讀音不是假名的一筆通不過覆核', () => {
  const entry = { surface: '堕天使', reading: 'datenshi', scope: 'global' };
  const dict = emptyDict();
  applyReading(dict, entry);

  assert.equal(survivesValidation(dict, entry), false);
});
