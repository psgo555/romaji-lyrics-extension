/**
 * test-corrections.js
 * 讀音修正字典的驗證腳本(步驟5.5)。
 *
 * 直接 import 擴充功能實際使用的那份字典(src/content/corrections.js),
 * 不另外複製一份 —— 這樣測到的就是線上跑的邏輯,不會有兩份表格漂移的問題。
 */

import KuroshiroModule from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';
import { applyCorrections, CORRECTIONS } from '../src/content/corrections.js';

// kuroshiro 是 babel 編譯的 CJS,在 Node ESM 下要自己取 .default
const Kuroshiro = KuroshiroModule.default ?? KuroshiroModule;

async function main() {
  const kuroshiro = new Kuroshiro();
  await kuroshiro.init(new KuromojiAnalyzer());

  console.log(`=== 修正前 vs 修正後 對照(字典共 ${CORRECTIONS.length} 筆) ===\n`);

  const testLines = [
    '響めき 煌めきと君も',
    '二人歳を重ねてた',
    '二人刻もう',
  ];

  let changed = 0;

  for (const line of testLines) {
    const before = await kuroshiro.convert(line, { to: 'romaji', mode: 'spaced' });
    const corrected = applyCorrections(line);
    const after = await kuroshiro.convert(corrected, { to: 'romaji', mode: 'spaced' });

    if (before !== after) changed += 1;

    console.log(`原文: ${line}`);
    console.log(`修正前: ${before}`);
    console.log(`修正後: ${after}`);
    console.log(before === after ? '(無變化)' : '✓ 已修正');
    console.log('---');
  }

  console.log(`\n${changed}/${testLines.length} 行被修正字典改寫`);
}

main().catch((err) => {
  console.error('轉換過程發生錯誤:', err);
  process.exit(1);
});
