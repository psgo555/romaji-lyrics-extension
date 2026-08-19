/**
 * shared-dictionary.test.js
 * 共用字典的驗證。
 *
 * 這是整個專案裡唯一「內容不由自己掌控、卻會影響畫面」的資料,
 * 所以這一支的重點不是「好資料能通過」,而是**壞資料進不來**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseSharedDictionary, SUPPORTED_VERSION } from '../src/shared/shared-dictionary.js';

const ok = (entries) => ({ version: SUPPORTED_VERSION, entries });

/* ------------------------------------------------ 正常情況 */

test('合法的資料原樣通過', () => {
  const { entries, skipped } = parseSharedDictionary(
    ok([{ surface: '心の臓', reading: 'しんのぞう' }])
  );
  assert.deepEqual(entries, [{ surface: '心の臓', reading: 'しんのぞう' }]);
  assert.equal(skipped, 0);
});

test('note 不會流進轉換流程', () => {
  // 那是給人看的,留著只會讓下游多一個沒人用的欄位
  const { entries } = parseSharedDictionary(
    ok([{ surface: '二人', reading: 'ふたり', note: '出處說明' }])
  );
  assert.deepEqual(Object.keys(entries[0]).sort(), ['reading', 'surface']);
});

test('守衛條目:讀音跟原文一樣代表原樣放過', () => {
  const { entries } = parseSharedDictionary(ok([{ surface: '一人称', reading: '一人称' }]));
  assert.equal(entries.length, 1);
});

/* ------------------------------- 結構壞掉 → 整份不要 */

test('認不得的版本整份忽略', () => {
  // 舊版擴充功能碰到新格式時,寧可用內建字典也不要亂解讀
  const raw = { version: 999, entries: [{ surface: 'あ', reading: 'あ' }] };
  assert.deepEqual(parseSharedDictionary(raw).entries, []);
});

test('壞掉的輸入不丟例外,回空陣列', () => {
  for (const bad of [null, undefined, 'abc', 123, [], {}, { version: 1 }]) {
    assert.deepEqual(
      parseSharedDictionary(bad).entries,
      [],
      `${JSON.stringify(bad)} 應該回空陣列`
    );
  }
});

test('entries 不是陣列就整份不要', () => {
  assert.deepEqual(parseSharedDictionary({ version: 1, entries: 'nope' }).entries, []);
});

/* ------------------------------- 單筆壞掉 → 只跳過那一筆 */

test('讀音不是假名的擋下來', () => {
  /*
   * 這是最重要的一項。有人填了漢字或英文進來的話,那筆會蓋過
   * kuromoji 本來正確的判斷,而畫面上看起來跟正常的一模一樣。
   */
  const { entries, skipped } = parseSharedDictionary(
    ok([
      { surface: '好的', reading: 'よい' },
      { surface: '壞的', reading: '漢字' },
      { surface: '也壞', reading: 'romaji' },
    ])
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].surface, '好的');
  assert.equal(skipped, 2);
});

test('少欄位、型別不對、空字串都擋下來', () => {
  const { entries } = parseSharedDictionary(
    ok([
      { surface: '有効', reading: 'ゆうこう' },
      { surface: '沒讀音' },
      { reading: 'よみ' },
      { surface: '', reading: 'から' },
      { surface: '空讀音', reading: '' },
      { surface: 123, reading: 'すうじ' },
      null,
      'not an object',
    ])
  );
  assert.equal(entries.length, 1);
});

test('過長的條目擋下來(比對是逐位置跑的,長字串會拖慢每一行)', () => {
  const { entries } = parseSharedDictionary(
    ok([
      { surface: 'あ'.repeat(500), reading: 'あ' },
      { surface: '正常', reading: 'せいじょう' },
    ])
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].surface, '正常');
});

test('重複的原文以先出現的為準', () => {
  // 後面的不可以偷偷蓋掉前面的
  const { entries } = parseSharedDictionary(
    ok([
      { surface: '二人', reading: 'ふたり' },
      { surface: '二人', reading: 'ににん' },
    ])
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reading, 'ふたり');
});

/* ------------------------------- 真的那份檔案 */

test('專案裡的 dictionary.json 本身是合法的', () => {
  /*
   * 這一項會在有人手改壞那個檔案時失敗。
   * 那個檔案是要送給所有使用者的,壞掉不能等到上線才發現。
   */
  const raw = JSON.parse(readFileSync(new URL('../dictionary.json', import.meta.url), 'utf8'));
  const { entries, skipped } = parseSharedDictionary(raw);

  assert.equal(skipped, 0, '有條目沒通過驗證,檢查 dictionary.json');
  assert.ok(entries.length > 0, 'dictionary.json 不該是空的');
});

test('只有疊字符的條目擋下來(資料層也要擋,不能只靠面板)', () => {
  /*
   * 面板已經擋了一層,但有人直接送 PR 改 dictionary.json 時
   * 面板的防護一點作用都沒有。這一筆若進了字典,
   * 人々 會變成 ひとどき —— 而且是所有使用者。
   */
  const { entries, skipped } = parseSharedDictionary(
    ok([
      { surface: '々', reading: 'どき' },
      { surface: '時々', reading: 'ときどき' },
    ])
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].surface, '時々');
  assert.equal(skipped, 1);
});
