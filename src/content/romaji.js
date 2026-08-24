/**
 * romaji.js
 * kuroshiro 轉換層,由 test-kanji.js 驗證過的設定移植而來。
 *
 * 與 Node 版 test-kanji.js 的兩項差異:
 *
 *   1. 辭典路徑指向擴充功能自身的資源(chrome.runtime.getURL)而非 node_modules,
 *      對應 manifest 的 web_accessible_resources
 *   2. 模組載入即開始 init,不等待使用者開啟歌詞面板 —— kuromoji 載入辭典耗時甚久,
 *      延後啟動會使前幾行歌詞來不及轉換
 */

import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';
import { applyCorrections } from './corrections.js';
import { loadUserCorrections, previewCorrections } from './corrections-store.js';
import { hasJapanese, stripIterationMarks } from './cjk.js';
import { digitsToKanji } from './numbers.js';
import { stripMacrons, stripProlongMarks } from './macron.js';

const LOG = '[romaji]';

const kuroshiro = new Kuroshiro();

/**
 * 轉換結果快取。Spotify 捲動時同一行會重複 render,無快取則每次重跑形態素分析。
 *
 * key 必須包含轉換種類:同一句歌詞轉羅馬拼音與轉平假名是兩個不同的結果。
 * 僅以原文為 key 時,切換至平假名模式會取得先前存入的拼音(反之亦然),
 * 且因快取存在,錯誤結果會持續留存。
 * kind 僅有 'romaji' 與 'kana' 兩種取值,不含冒號,組合後不會產生衝突。
 */
const cache = new Map();
const MAX_CACHE = 2000;

function cacheKey(kind, text) {
  return `${kind}:${text}`;
}

let initError = null;

/**
 * 立即開始初始化。此為 module-level 的 Promise,
 * 後續所有 toRomaji() 呼叫皆 await 同一個實例,不會重複初始化。
 */
export const ready = (async () => {
  const startedAt = performance.now();
  try {
    // 自訂讀音須一併等待:否則最初幾行會在字典尚未載入的狀態下轉換,
    // 舊結果進入快取後,使用者會認為自己新增的修正未生效。
    await Promise.all([
      kuroshiro.init(new KuromojiAnalyzer({ dictPath: chrome.runtime.getURL('dict/') })),
      loadUserCorrections(),
    ]);
    console.info(`${LOG} kuroshiro ready in ${Math.round(performance.now() - startedAt)}ms`);
  } catch (err) {
    initError = err;
    console.error(`${LOG} kuroshiro 初始化失敗,羅馬拼音功能無法使用:`, err);
    throw err;
  }
})();

// 避免 init 失敗時產生 unhandled rejection(實際錯誤已於上方記錄)
ready.catch(() => {});

// 判定規則集中於 cjk.js(「此行是否需要轉換」與「哪些字未轉出」屬同一項判斷),
// 此處再次轉出,對外介面不變。
export { hasJapanese };

/**
 * 日文 → 羅馬拼音。
 * mode 沿用 test-kanji.js 驗證過的 'spaced':跟唱時分詞空格較易閱讀。
 * @param {string} text
 * @returns {Promise<string|null>} 無法轉換或無須轉換時回 null
 */
export async function toRomaji(text) {
  return convert('romaji', text);
}

/**
 * 日文 → 平假名讀音,供平假名注音模式使用。
 *
 * 對於能閱讀假名、僅受阻於漢字的使用者,此模式較羅馬拼音實用 —— 拼音會將整句
 * 換為另一套文字,連原本即可讀出的假名亦一併替換。
 *
 * mode 同樣採 'spaced':分詞空格便於斷讀長句,與拼音模式一致,
 * 逐字掃描亦需要對應的 span 才能上色。
 *
 * @param {string} text
 * @returns {Promise<string|null>} 無法轉換或無須轉換時回 null
 */
export async function toKana(text) {
  return convert('kana', text);
}

/**
 * 兩種轉換共用的流程。
 *
 * 合併為單一實作的原因:除了傳給 kuroshiro 的 to 參數,以及是否移除長音符之外,
 * 判定、快取、修正字典與錯誤處理完全相同。分開實作時,單方面的變更(例如新增
 * 一道前處理)會使另一方安靜地走上不同路徑。
 *
 * @param {'romaji'|'kana'} kind
 */
async function convert(kind, text) {
  if (!text || !hasJapanese(text)) return null;

  const key = cacheKey(kind, text);
  if (cache.has(key)) return cache.get(key);

  await ready;
  if (initError) return null;

  try {
    // 先將已知會被 kuromoji 讀錯的詞替換為正確的平假名讀音,再送入斷詞。
    // kuroshiro 不會重新判斷平假名的讀音,替換過的部分因而保證正確,詳見 corrections.js。
    // 接著將阿拉伯數字改寫為漢字數字,量詞的不規則讀法才能取自辭典(見 numbers.js)。
    // 順序須置於修正之後:修正以原文比對,先改寫數字會使含數字的條目無法命中。
    const corrected = digitsToKanji(applyCorrections(text));
    const converted = await kuroshiro.convert(corrected, {
      to: kind === 'kana' ? 'hiragana' : 'romaji',
      mode: 'spaced',
    });

    /*
     * 平假名模式不作處理:該模式的長音本即寫為「おう」「うう」等假名,
     * 而原樣保留的 ー 在假名輸出中屬正確寫法。
     *
     * 羅馬拼音模式須處理三項:
     *   stripMacrons        移除 ā ō 的長音符(長度不變)
     *   stripProlongMarks   辭典未收錄的詞會原樣輸出 ー,該符號並非羅馬字
     *   stripIterationMarks 同理,殘留至此的 々 表示未配對到任何字
     */
    const trimmed = converted ? converted.trim() : null;
    const result = trimmed
      ? kind === 'kana'
        ? trimmed
        : stripIterationMarks(stripProlongMarks(stripMacrons(trimmed)))
      : null;

    // 容量上限:達到後移除最舊的一筆(Map 保證插入順序)
    if (cache.size >= MAX_CACHE) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`${LOG} 轉換失敗(${kind}):`, text, err);
    return null;
  }
}

/**
 * 清除轉換結果快取。
 * 使用者新增或刪除自訂讀音後須呼叫,否則畫面仍顯示先前的轉換結果。
 */
export function invalidateRomajiCache() {
  cache.clear();
}

/**
 * 試轉一行,套用尚未存檔的修正,且不寫入快取。供修正面板的即時預覽使用。
 *
 * @param {string} text 原始歌詞行
 * @param {{surface: string, reading: string}|null} candidate 正在試用的修正
 */
export async function previewRomaji(text, candidate) {
  if (!text) return null;
  await ready;
  if (initError) return null;

  try {
    // 前處理與 convert() 完全一致,預覽才會等同於實際結果
    const corrected = digitsToKanji(previewCorrections(text, candidate));
    const romaji = await kuroshiro.convert(corrected, { to: 'romaji', mode: 'spaced' });
    // 出口處理亦須與 convert() 完全一致:使用者依據預覽決定是否儲存,
    // 預覽與實際結果不符即為誤導
    return romaji ? stripIterationMarks(stripProlongMarks(stripMacrons(romaji.trim()))) : null;
  } catch (err) {
    console.warn(`${LOG} 預覽轉換失敗:`, text, err);
    return null;
  }
}
