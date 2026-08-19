/**
 * corrections.test.js
 * 讀音修正字典的行為測試。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * legacy/ 底下那三支「測試」腳本一個斷言都沒有,只把結果印出來讓人看,
 * 所以不管轉出什麼都會 exit 0。實際驗證過:把「二人」的讀音改成
 * 完全無關的「でたらめ」,腳本照樣印出「✓ 已修正 / 3/3 行被改寫」並回報通過。
 *
 * 這裡測的是純邏輯,不載入 kuromoji 辭典,所以跑起來是毫秒級的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRECTIONS,
  applyCorrections,
  applyCorrectionsWith,
  sortCorrections,
  setActiveCorrections,
} from '../src/content/corrections.js';

test('長詞優先:短詞不可以鑽進長詞裡把它弄壞', () => {
  // 這是整張表最重要的性質。「一人」如果鑽進「一人称」,
  // 會把本來就正確的詞弄成「ひとり称」,比不修還糟。
  assert.equal(applyCorrections('一人称'), '一人称');

  // 反過來,單獨的「一人」還是要被修
  assert.equal(applyCorrections('一人で'), 'ひとりで');
});

test('比對到就把那一段消耗掉,不會重複套用', () => {
  const list = sortCorrections([
    { surface: '二人', reading: 'ふたり' },
    { surface: 'ふた', reading: 'XX' }, // 若不消耗,會鑽進上一條的結果裡
  ]);
  assert.equal(applyCorrectionsWith('二人', list), 'ふたり');
});

test('沒對到的字原樣保留', () => {
  assert.equal(applyCorrectionsWith('あいうえお', []), 'あいうえお');
  assert.equal(applyCorrectionsWith('', []), '');
});

test('內建表的每一筆都有原文與讀音', () => {
  for (const entry of CORRECTIONS) {
    assert.ok(entry.surface, `surface 不可為空:${JSON.stringify(entry)}`);
    assert.ok(entry.reading, `reading 不可為空:${JSON.stringify(entry)}`);
  }
});

test('內建表已按原文長度由長到短排序', () => {
  const lengths = CORRECTIONS.map((c) => c.surface.length);
  const sorted = [...lengths].sort((a, b) => b - a);
  assert.deepEqual(lengths, sorted);
});

test('內建表的讀音沒有被改壞(逐筆對照已知正確值)', () => {
  /*
   * 為什麼要把值寫死在測試裡:
   *
   * 上面那些測試驗的是「機制」(長詞優先、消耗、排序),但機制正確不代表
   * 資料正確 —— 把「二人」的讀音改成完全無關的「でたらめ」,那些測試
   * 全部照樣通過。legacy/ 那三支示範腳本更是連改成亂碼都會印「✓ 已修正」。
   *
   * 所以這一筆是**對照表**:改動任何一個讀音都必須同時改這裡,
   * 逼人正面回答「我是有意改的嗎」。
   */
  const expected = {
    響めき: 'どよめき',
    二人: 'ふたり',
    一人: 'ひとり',
    一人称: '一人称', // 守衛條目,原樣保留
    藻掻もが: 'もが',
  };

  for (const [surface, reading] of Object.entries(expected)) {
    const entry = CORRECTIONS.find((c) => c.surface === surface);
    assert.ok(entry, `內建表少了「${surface}」`);
    assert.equal(entry.reading, reading, `「${surface}」的讀音跟預期不符`);
  }
});

test('高頻詞的實際轉換結果正確', () => {
  // 直接驗結果,而不只是驗表格內容 —— 表對了但套用邏輯壞了一樣會出錯
  assert.equal(applyCorrections('二人'), 'ふたり');
  assert.equal(applyCorrections('一人'), 'ひとり');
  assert.equal(applyCorrections('響めき'), 'どよめき');
  assert.equal(applyCorrections('二人歳を重ねてた'), 'ふたり歳を重ねてた');
});

test('守衛條目:讀音與原文相同代表「原樣放過」', () => {
  // 「一人称」kuromoji 本來就讀得對,寫成跟原文一樣是為了消耗掉這一段,
  // 讓後面的「一人」進不來。這筆若被誤改成假名,反而會讓 kuromoji 讀更差。
  const guard = CORRECTIONS.find((c) => c.surface === '一人称');
  assert.ok(guard, '守衛條目「一人称」不見了');
  assert.equal(guard.reading, '一人称');
});

test('行內振假名:原文要連同重複的假名一起涵蓋', () => {
  // 「藻掻もがいて」若只把「藻掻」換成「もが」,後面本來就有的「もが」
  // 會被留下來,變成讀音唸兩次。
  assert.equal(applyCorrections('藻掻もがいて'), 'もがいて');
});

test('setActiveCorrections 換表之後立刻生效', () => {
  const original = [...CORRECTIONS];
  try {
    setActiveCorrections([{ surface: '試験', reading: 'しけん' }]);
    assert.equal(applyCorrections('試験'), 'しけん');
    // 換過表之後,原本內建的那些就不在生效清單裡了
    assert.equal(applyCorrections('二人'), '二人');
  } finally {
    setActiveCorrections(original); // 不要污染其他測試
  }
});

test('使用者的同名項目覆蓋內建的', () => {
  const merged = sortCorrections([
    { surface: '二人', reading: 'にんげん' }, // 假裝這是使用者自訂的
  ]);
  assert.equal(applyCorrectionsWith('二人', merged), 'にんげん');
});
