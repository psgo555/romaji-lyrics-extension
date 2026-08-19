/**
 * romaji.js
 * 把 test-kanji.js 驗證過的 kuroshiro 邏輯搬進擴充功能。
 *
 * 兩個關鍵差異(相對於 Node 版的 test-kanji.js):
 * 1. 辭典路徑要指向擴充功能自己的資源(chrome.runtime.getURL),
 *    不是 node_modules。對應 manifest 的 web_accessible_resources。
 * 2. 模組一被載入就開始 init,不等使用者打開歌詞面板。
 *    (README 限制 #2:kuromoji 載辭典很慢,必須提早做)
 */

import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';
import { applyCorrections } from './corrections.js';
import { loadUserCorrections, previewCorrections } from './corrections-store.js';
import { hasJapanese } from './cjk.js';
import { stripMacrons } from './macron.js';

const LOG = '[romaji]';

const kuroshiro = new Kuroshiro();

/**
 * 轉換結果快取。Spotify 捲動時同一行會被重複 render,沒快取會重跑形態素分析。
 *
 * key 一定要帶上轉換種類:同一句歌詞轉羅馬拼音跟轉平假名是兩個不同的答案。
 * 只用原文當 key 的話,切到平假名模式會拿到先前存的拼音(反之亦然),
 * 而且因為有快取,那個錯誤結果會一直黏著不會自己好。
 * kind 的取值只有 'romaji' / 'kana',不含冒號,所以拼起來不會撞號。
 */
const cache = new Map();
const MAX_CACHE = 2000;

function cacheKey(kind, text) {
  return `${kind}:${text}`;
}

let initError = null;

/**
 * 立刻開始初始化。這是一個 module-level 的 Promise,
 * 之後所有 toRomaji() 呼叫都 await 同一個,不會重複初始化。
 */
export const ready = (async () => {
  const startedAt = performance.now();
  try {
    // 自訂讀音也要一起等 —— 否則最早那幾行會用「還沒載入字典」的狀態轉換,
    // 轉出來是舊的結果又進了快取,使用者會以為自己加的修正沒生效。
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

// 避免 init 失敗時噴出 unhandled rejection(實際錯誤已在上面記錄)
ready.catch(() => {});

// 判定規則搬到 cjk.js 集中管理(「這行要不要轉」與「哪幾個字沒轉出來」
// 問的是同一件事),這裡再匯出一次,對外介面不變。
export { hasJapanese };

/**
 * 日文 → 羅馬拼音。
 * mode: 'spaced' 沿用 test-kanji.js 驗證過的設定 — 跟唱時分詞有空格比較好讀。
 * @param {string} text
 * @returns {Promise<string|null>} 轉不出來或不需轉時回 null
 */
export async function toRomaji(text) {
  return convert('romaji', text);
}

/**
 * 日文 → 平假名讀音。平假名注音模式用這個。
 *
 * 對「看得懂假名、只卡在漢字」的人來說,這比羅馬拼音好用得多 ——
 * 拼音把整句都換成另一套文字,連本來就讀得出來的假名也一起換掉了。
 *
 * mode 同樣用 'spaced':分詞空格讓長句好斷,跟拼音那邊一致,
 * 逐字掃描也才有 span 可以上色。
 *
 * @param {string} text
 * @returns {Promise<string|null>} 轉不出來或不需轉時回 null
 */
export async function toKana(text) {
  return convert('kana', text);
}

/**
 * 兩種轉換共用的流程。
 *
 * 之所以合成一支:除了「送給 kuroshiro 的 to 是什麼」以及
 * 「要不要拿掉長音符」之外,判斷、快取、修正字典、錯誤處理全部一樣。
 * 各寫一份的話,哪天改了其中一邊(例如加了一道前處理),
 * 另一邊就會安靜地走上不同的路。
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
    // 先把已知會被 kuromoji 讀錯的詞換成正確的平假名讀音,再送去斷詞。
    // kuroshiro 不會重新判斷平假名的讀音,所以取代過的部分保證轉對。
    // 詳見 corrections.js。
    const corrected = applyCorrections(text);
    const converted = await kuroshiro.convert(corrected, {
      to: kind === 'kana' ? 'hiragana' : 'romaji',
      mode: 'spaced',
    });

    // 長音符只有羅馬拼音才有(ō ē)。平假名的長音本來就是寫成
    // 「おう」「うう」這樣的假名,沒有頭上一橫可以拿掉。
    const trimmed = converted ? converted.trim() : null;
    const result = trimmed ? (kind === 'kana' ? trimmed : stripMacrons(trimmed)) : null;

    // 簡單的容量上限:滿了就清掉最舊的一筆(Map 保證插入順序)
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
 * 清掉轉換結果的快取。
 * 使用者新增/刪除自訂讀音之後一定要呼叫,否則畫面上還是舊的轉換結果。
 */
export function invalidateRomajiCache() {
  cache.clear();
}

/**
 * 試轉一行,但套用「還沒存檔的那一筆修正」,而且**不進快取**。
 * 修正 popover 的即時預覽用這個。
 *
 * @param {string} text 原始歌詞行
 * @param {{surface: string, reading: string}|null} candidate 正在試的那筆
 */
export async function previewRomaji(text, candidate) {
  if (!text) return null;
  await ready;
  if (initError) return null;

  try {
    const corrected = previewCorrections(text, candidate);
    const romaji = await kuroshiro.convert(corrected, { to: 'romaji', mode: 'spaced' });
    return romaji ? stripMacrons(romaji.trim()) : null;
  } catch (err) {
    console.warn(`${LOG} 預覽轉換失敗:`, text, err);
    return null;
  }
}
