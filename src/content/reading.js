/**
 * reading.js
 * 將使用者輸入的讀音正規化為假名。
 *
 * 修正面板原先僅接受假名,但該要求存在矛盾:須先知道假名寫法才能修正讀音,
 * 而知道的使用者多半不需要本擴充功能。使用者實際持有的資訊是羅馬拼音。
 *
 * 因此兩種格式皆接受:假名照舊,羅馬拼音自動轉為假名。轉換使用 wanakana,
 * 該套件已為拼音路徑所需,不增加相依。
 *
 * 本模組不使用 chrome API 亦不操作畫面,可直接以 Node 測試。
 */

import { toKana } from 'wanakana';

/*
 * 讀音驗證位於 cjk.js —— 該判斷本質為字元分類,且該模組不 import 任何項目。
 * 置於此處會使僅需該判斷的模組(背景程式、共用字典驗證)連帶打包 wanakana。
 *
 * 此處僅轉出,本模組未使用。若日後本模組需要使用,須同時加上 import 與
 * export 兩行(參見 corrections-store.js 的註記)。
 */
export { READING_PATTERN, isValidReading } from './cjk.js';

/**
 * 將輸入轉為假名。
 *
 * 無法轉換的部分原樣保留(例如英文或漢字),由呼叫端的 isValidReading 判定。
 * 本函式僅負責轉換,不進行驗證。
 *
 * 空白一律移除:羅馬拼音分詞時容易輸入為 `shin no zou`,而讀音本身不含空白,
 * 保留會導致驗證失敗且使用者無從得知原因。
 *
 * @param {string} input 假名或羅馬拼音,例如 `しんのぞう` 或 `shin no zou`
 * @returns {string} 假名
 */
export function toKanaReading(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return '';

  // 純假名於 wanakana 中原樣通過,不會被改寫
  return toKana(trimmed).replace(/\s+/g, '');
}
