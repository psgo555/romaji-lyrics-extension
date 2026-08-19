const Kuroshiro = require('kuroshiro').default;
const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');

async function main() {
  const kuroshiro = new Kuroshiro();
  // 初始化形態素分析器(第一次執行會需要載入辭典,稍等一下)
  await kuroshiro.init(new KuromojiAnalyzer());

  console.log('=== 混合漢字歌詞 → 羅馬拼音 測試 ===\n');

  const testLines = [
    '桜が咲く',                  // 之前 wanakana 單獨處理失敗的例子
    '君と僕の物語',              // 常見歌詞句型:名詞+助詞
    '夢のなかで会えたら',        // 動詞變化情境
    '心の中にあるダイヤモンド',  // 漢字+片假名混合
    '愛してる',                  // 常見歌詞用語
  ];

  for (const line of testLines) {
    const romaji = await kuroshiro.convert(line, { to: 'romaji', mode: 'spaced' });
    console.log(`原文: ${line}`);
    console.log(`羅馬拼音: ${romaji}`);
    console.log('---');
  }
}

main().catch((err) => {
  console.error('轉換過程發生錯誤:', err);
});
