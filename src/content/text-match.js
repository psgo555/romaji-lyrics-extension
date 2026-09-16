/**
 * text-match.js
 * 歌詞比對用的正規化。純函式,不 import 任何項目。
 *
 * 獨立成一支的原因:逐句對齊(sync-highlight.js)與字元對齊(lyrics-align.js)
 * 必須套用同一套規則。兩份實作一旦分岔,症狀是某些曲目的對齊率莫名下降,
 * 而且不會拋出任何錯誤 —— 本專案已於「長音符」與「曲目長度」各發生過一次
 * 同類問題(見 DEVELOPMENT.md)。
 */

/**
 * 僅保留具辨識度的部分:全形轉半形、去除空白與標點、英文轉小寫。
 *
 * 不同來源的同一句歌詞在空白與標點上幾乎必然有差異(Musixmatch 的
 * 「粉雪 ねえ 心まで」對 LRCLIB 的「粉雪ねえ心まで」),逐字元比對會全數落空。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  return (text ?? '')
    .normalize('NFKC') // 全形英數 → 半形,相容字 → 標準字
    .replace(/\s+/g, '')
    .replace(/[!-/:-@[-`{-~、-〟｡-･]/g, '') // 一律移除標點
    .toLowerCase();
}
