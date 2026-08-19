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

/**
 * 讀音只接受假名與長音符 —— 混進漢字等於沒修正到。
 *
 * 跟 toKanaReading 放在同一支:「什麼算有效讀音」與「把輸入變成讀音」
 * 是同一件事的兩面,拆開放的話,哪天放寬了其中一邊就會對不上。
 * (原本這條在 corrections-store.js,但那支有 module-level 的 chrome 呼叫,
 *  Node 測不到 —— 而這正是最需要測的部分。)
 */
export const READING_PATTERN = /^[ぁ-ゟ゠-ヿー]+$/u;

export function isValidReading(reading) {
  return READING_PATTERN.test(reading ?? '');
}

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
