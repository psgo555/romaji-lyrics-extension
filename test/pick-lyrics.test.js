/**
 * pick-lyrics.test.js
 * 自 LRCLIB 的搜尋結果挑出要用的那一筆。
 *
 * 這一支最重要的是第一段:**沒有參考歌詞時,結果必須與抽出前的規則完全相同**。
 * Spotify 的備援走的正是這條路,挑選規則一變,使用者看到的就是另一個版本的歌詞。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLyrics, toPayload, japaneseRatio } from '../src/shared/pick-lyrics.js';

/** 以 [時間秒, 文字] 組出 syncedLyrics */
const synced = (...pairs) =>
  pairs.map(([sec, text]) => `[00:${String(sec).padStart(2, '0')}.00] ${text}`).join('\n');

const JP_LINES = ['沈むように溶けてゆくように', '二人だけの空が広がる夜に', '「さよなら」だけだった'];
const jpSynced = synced([10, JP_LINES[0]], [15, JP_LINES[1]], [20, JP_LINES[2]]);
const romajiSynced = synced(
  [10, 'shizumu you ni tokete yuku you ni'],
  [15, 'futari dake no sora ga hirogaru yoru ni'],
  [20, 'sayonara dake datta']
);

const entry = (over) => ({ trackName: '夜に駆ける', artistName: 'YOASOBI', duration: 261, ...over });

/* ------------------------------------------- 沒有參考歌詞(Spotify 既有路徑) */

test('有時間軸的優先於只有純文字的', () => {
  const picked = pickLyrics([entry({ plainLyrics: JP_LINES.join('\n') }), entry({ syncedLyrics: jpSynced })]);
  assert.equal(picked.best.syncedLyrics, jpSynced);
  assert.equal(picked.pickedBy, 'metadata');
  assert.equal(picked.times, null);
});

test('同為有時間軸時,取日文行比例較高者(避開對照翻譯版)', () => {
  const bilingual = entry({ syncedLyrics: synced([10, JP_LINES[0]], [10, 'Melting away like sinking'], [15, JP_LINES[1]], [15, 'The sky spreads out']) });
  const picked = pickLyrics([bilingual, entry({ syncedLyrics: jpSynced })]);
  assert.equal(picked.best.syncedLyrics, jpSynced);
});

test('長度差超過 3 秒的版本先被排除', () => {
  const live = entry({ duration: 320, syncedLyrics: jpSynced });
  const album = entry({ duration: 259, syncedLyrics: romajiSynced });
  const picked = pickLyrics([live, album], { durationSec: 261 });
  assert.equal(picked.best, album, '應挑長度相近的那一筆,即使內容是拼音版');
});

test('長度全都對不上時退回全部,不會變成沒有歌詞', () => {
  const picked = pickLyrics([entry({ duration: 400, syncedLyrics: jpSynced })], { durationSec: 261 });
  assert.ok(picked);
  assert.equal(picked.best.duration, 400);
});

test('沒有可用結果時回 null', () => {
  assert.equal(pickLyrics([]), null);
  assert.equal(pickLyrics(null), null);
  assert.equal(pickLyrics([{ trackName: 'x' }]), null, '沒有任何歌詞欄位的不算可用');
});

/* ------------------------------------------- 有參考歌詞(YouTube Music) */

test('依內容挑選:避開拼音版,挑到與畫面相同的日文版', () => {
  /*
   * 實測情境:YouTube Music 的歌手名為英文時,LRCLIB 該名稱下多為拼音版。
   * 依日文比例挑會挑到拼音版 —— 時間軸對得上,文字卻與畫面完全不同。
   */
  const romaji = entry({ syncedLyrics: romajiSynced });
  const japanese = entry({ syncedLyrics: jpSynced });
  const picked = pickLyrics([romaji, japanese], { durationSec: 261, referenceLines: JP_LINES });
  assert.equal(picked.best, japanese);
  assert.equal(picked.pickedBy, 'content');
  assert.deepEqual(picked.times, [10000, 15000, 20000]);
  assert.ok(picked.coverage > 0.9);
});

test('畫面與 LRC 斷行不同時仍對得上,並給出每一行的時間', () => {
  const merged = entry({ syncedLyrics: synced([10, JP_LINES[0] + JP_LINES[1]], [20, JP_LINES[2]]) });
  const picked = pickLyrics([merged], { durationSec: 261, referenceLines: JP_LINES });
  assert.equal(picked.pickedBy, 'content');
  assert.equal(picked.times[0], 10000);
  assert.ok(picked.times[1] > 10000 && picked.times[1] < 20000, `行中內插超出範圍:${picked.times[1]}`);
  assert.equal(picked.times[2], 20000);
});

test('沒有一筆對得上:仍回傳歌詞,但不給時間', () => {
  // 對不上的時間軸套到畫面上,高亮會停在錯的句子 —— 寧可沒有高亮
  const picked = pickLyrics([entry({ syncedLyrics: romajiSynced })], {
    durationSec: 261,
    referenceLines: ['まったく関係のない歌詞です', '一致するはずがありません'],
  });
  assert.equal(picked.pickedBy, 'metadata');
  assert.equal(picked.times, null);
  assert.ok(picked.best.syncedLyrics);
});

test('只有純文字的條目不會被內容挑選選中(沒有時間軸可借)', () => {
  const picked = pickLyrics([entry({ plainLyrics: JP_LINES.join('\n') })], {
    durationSec: 261,
    referenceLines: JP_LINES,
  });
  assert.equal(picked.pickedBy, 'metadata');
  assert.equal(picked.times, null);
});

/* ------------------------------------------- 其他 */

test('japaneseRatio:對照翻譯版明顯低於純日文版', () => {
  const pure = { syncedLyrics: jpSynced };
  const bilingual = { syncedLyrics: `${JP_LINES[0]}\nMelting away\n${JP_LINES[1]}\nThe sky spreads` };
  assert.ok(japaneseRatio(pure) > japaneseRatio(bilingual));
  assert.equal(japaneseRatio({}), 0);
});

test('toPayload:純文字逐行去空白並移除空行', () => {
  const payload = toPayload(pickLyrics([entry({ plainLyrics: `  ${JP_LINES[0]}  \n\n${JP_LINES[1]}\n` })]));
  assert.deepEqual(payload.lines, [JP_LINES[0], JP_LINES[1]]);
  assert.equal(payload.synced, null);
  assert.equal(payload.times, null);
});

test('toPayload:沒有挑到任何一筆時回 null', () => {
  assert.equal(toPayload(null), null);
});
