/**
 * sokuon.test.js
 * 促音落在斷詞邊界時的 token 合併。
 *
 * 不載入 kuromoji 辭典:token 以手寫的方式模擬 kuromoji 的輸出。
 * 最後兩項把手寫 token 交給真正的 kuroshiro 轉換 —— 合併後的形狀若不符 kuroshiro 的
 * 預期(例如發音沒接上),只驗合併函式本身是看不出來的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import KuroshiroModule from 'kuroshiro';

import { mergeSokuonTokens, withSokuonMerge } from '../src/content/sokuon.js';

// kuroshiro 為 CommonJS,類別掛在 default 上
const Kuroshiro = KuroshiroModule.default ?? KuroshiroModule;

/** 模擬 kuromoji 的 token。未給發音時沿用讀音(kuromoji 對多數詞即是如此) */
const tok = (surface_form, reading, pronunciation = reading, pos = '助動詞') => ({
  surface_form,
  reading,
  pronunciation,
  pos,
});

const surfaces = (tokens) => tokens.map((t) => t.surface_form);

test('だっ|た 合併為一個 token,讀音與發音一併相接', () => {
  const [merged, ...rest] = mergeSokuonTokens([tok('だっ', 'ダッ'), tok('た', 'タ')]);
  assert.equal(rest.length, 0);
  assert.equal(merged.surface_form, 'だった');
  assert.equal(merged.reading, 'ダッタ');
  assert.equal(merged.pronunciation, 'ダッタ');
});

test('動詞之後的 なかっ|た 合併,動詞本身不動', () => {
  const tokens = [tok('知ら', 'シラ', 'シラ', '動詞'), tok('なかっ', 'ナカッ'), tok('た', 'タ')];
  assert.deepEqual(surfaces(mergeSokuonTokens(tokens)), ['知ら', 'なかった']);
});

test('片假名的 ッ 同樣合併', () => {
  const tokens = [tok('ダッ', 'ダッ'), tok('タ', 'タ')];
  assert.deepEqual(surfaces(mergeSokuonTokens(tokens)), ['ダッタ']);
});

test('合併後仍以促音結尾時繼續往下併', () => {
  // 行っ|ちゃっ|た:只併一次會留下 ちゃっ|た,那一段一樣會轉成 tsu
  const tokens = [tok('行っ', 'イッ', 'イッ', '動詞'), tok('ちゃっ', 'チャッ', 'チャッ', '動詞'), tok('た', 'タ')];
  assert.deepEqual(surfaces(mergeSokuonTokens(tokens)), ['行っちゃった']);
});

test('促音後接標點或英文時不合併', () => {
  // 沒有子音可合併,硬併只會把標點黏進詞裡
  const punct = [tok('あっ', 'アッ', 'アッ', '感動詞'), { surface_form: '、', reading: '、', pronunciation: '、', pos: '記号' }];
  assert.deepEqual(surfaces(mergeSokuonTokens(punct)), ['あっ', '、']);

  const latin = [tok('えっ', 'エッ', 'エッ', '感動詞'), { surface_form: 'OK', pos: '名詞' }];
  assert.deepEqual(surfaces(mergeSokuonTokens(latin)), ['えっ', 'OK']);
});

test('句末的促音沒有下一個 token,維持原樣', () => {
  assert.deepEqual(surfaces(mergeSokuonTokens([tok('ほらっ', 'ホラッ', 'ホラッ', '感動詞')])), ['ほらっ']);
});

test('辭典未收錄(缺讀音或發音)的 token 不合併', () => {
  // 硬併的話讀音會接出 "undefined" 字串
  const unknown = [{ surface_form: 'ぱっ', pos: '名詞' }, tok('た', 'タ')];
  const result = mergeSokuonTokens(unknown);
  assert.deepEqual(surfaces(result), ['ぱっ', 'た']);
  // 兩者的讀音皆維持原狀:未收錄的仍缺讀音(留給 kuroshiro 補值),た 未被接上任何東西
  assert.equal(result[0].reading, undefined);
  assert.equal(result[1].reading, 'タ');
});

test('不修改傳入的 token', () => {
  const tokens = [tok('だっ', 'ダッ'), tok('た', 'タ')];
  const snapshot = JSON.stringify(tokens);
  mergeSokuonTokens(tokens);
  assert.equal(JSON.stringify(tokens), snapshot);
});

/* ------------------------------------------- 交給真正的 kuroshiro 轉換 */

/** 固定回傳同一組 token 的分析器,每次都給新的物件(kuroshiro 會就地修改 token) */
function stubAnalyzer(makeTokens) {
  return { init: async () => {}, parse: async () => makeTokens() };
}

/** 君|は|だっ|た。は 的讀音是 ハ、發音是 ワ —— 拼音應取發音 */
const kimiWaDatta = () => [
  tok('君', 'キミ', 'キミ', '名詞'),
  tok('は', 'ハ', 'ワ', '助詞'),
  tok('だっ', 'ダッ'),
  tok('た', 'タ'),
];

test('kuroshiro:未合併時是 datsu ta,合併後是 datta', async () => {
  const plain = new Kuroshiro();
  await plain.init(stubAnalyzer(kimiWaDatta));
  assert.equal(await plain.convert('君はだった', { to: 'romaji', mode: 'spaced' }), 'kimi wa datsu ta');

  const merged = new Kuroshiro();
  await merged.init(withSokuonMerge(stubAnalyzer(kimiWaDatta)));
  assert.equal(await merged.convert('君はだった', { to: 'romaji', mode: 'spaced' }), 'kimi wa datta');
});

test('kuroshiro:合併不影響其他 token 取發音(は 仍是 wa),平假名模式同樣合併', async () => {
  /*
   * 這是選擇本作法而非「假名 + wanakana」的理由:拼音仍取自發音,
   * は 維持 wa 而不會變成 ha(見 sokuon.js 檔頭)。
   */
  const merged = new Kuroshiro();
  await merged.init(withSokuonMerge(stubAnalyzer(kimiWaDatta)));
  const romaji = await merged.convert('君はだった', { to: 'romaji', mode: 'spaced' });
  assert.ok(romaji.includes(' wa '), `は 應為 wa:${romaji}`);
  assert.equal(await merged.convert('君はだった', { to: 'hiragana', mode: 'spaced' }), 'きみ は だった');
});
