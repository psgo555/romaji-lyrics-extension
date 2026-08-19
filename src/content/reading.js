/**
 * reading.js
 * 把使用者輸入的讀音正規化成假名。
 *
 * ── 為什麼需要這一支 ──────────────────────────────────────────
 * 補讀音的面板原本只收假名,但那對使用者是個矛盾的要求:
 * **要修讀音就得先知道讀音的假名寫法** —— 而知道的人多半不需要這個擴充功能。
 *
 * 實際上使用者腦裡有的是羅馬拼音(他會說「這唸 shin no zou」),
 * 再要他去查一次假名怎麼寫,等於把最麻煩的一段丟回給他。
 *
 * 所以兩種都收:假名照舊,羅馬拼音自動轉成假名。
 * 轉換用的 wanakana 本來就在專案裡(拼音那條路一直在用),不多帶相依。
 *
 * 這支不碰 chrome 也不碰畫面,所以可以直接用 Node 測。
 */

import { toKana } from 'wanakana';

/*
 * 讀音的驗證搬到 cjk.js 了 —— 那本質上是字元分類,而且那支不 import
 * 任何東西。放在這裡的話,只想要那個判斷的模組(背景程式、共用字典驗證)
 * 會連帶把 wanakana 一起打包進去。
 *
 * 這裡純轉手,自己沒用到,所以不需要額外的 import
 * (若哪天這支自己要用,記得 import 與 export 兩行都要 —— 見 corrections-store)。
 */
export { READING_PATTERN, isValidReading } from './cjk.js';

/**
 * 把輸入轉成假名。
 *
 * 轉不出來的部分會原樣留著(例如打了英文或漢字),
 * 交給呼叫端既有的 isValidReading 擋下 —— 這裡不做驗證,只做轉換。
 *
 * 空白一律拿掉:羅馬拼音分詞時很自然會打成 'shin no zou',
 * 但讀音本身不含空白,留著會讓驗證失敗而使用者看不出哪裡錯。
 *
 * @param {string} input 假名或羅馬拼音,例如 'しんのぞう' 或 'shin no zou'
 * @returns {string} 假名
 */
export function toKanaReading(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return '';

  // 純假名在 wanakana 本來就是原樣通過,不會被「修正」
  return toKana(trimmed).replace(/\s+/g, '');
}
