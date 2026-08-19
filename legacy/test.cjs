const wanakana = require('wanakana');

// 測試用的日文歌詞範例(平假名 + 片假名混合,模擬真實歌詞情境)
const testLines = [
  'さくらさくら',           // 純平假名
  'アイシテル',              // 純片假名
  'きみとぼく',              // 平假名
  'メロディー',              // 片假名(外來語常見)
  'ゆめのなかで',            // 平假名
  'ラブストーリー',          // 片假名
  'こころのなかに',          // 平假名
  'ダイヤモンド',            // 片假名
];

console.log('=== 假名 → 羅馬拼音 轉換測試 ===\n');

testLines.forEach((line) => {
  const romaji = wanakana.toRomaji(line);
  console.log(`原文: ${line}`);
  console.log(`羅馬拼音: ${romaji}`);
  console.log('---');
});

// 額外測試:混合漢字的情況(目前 wanakana 對漢字不會轉換,會直接跳過保留原字)
console.log('\n=== 混合漢字測試(預期:漢字部分不會被轉換) ===\n');
const kanjiMixed = '桜が咲く';
console.log(`原文: ${kanjiMixed}`);
console.log(`羅馬拼音: ${wanakana.toRomaji(kanjiMixed)}`);
console.log('→ 這種情況需要搭配 kuroshiro/kuromoji 先做形態素分析,將漢字轉成假名後再轉羅馬拼音');
