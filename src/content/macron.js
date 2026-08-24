/**
 * macron.js
 * 長音符處理,集中於單一模組。
 *
 * romaji.js 轉換時須移除長音符,splitter.js 比對既有斷字資料時須套用同一套規則
 * (舊資料存於移除長音符之前,含 ō 與 ē)。分別實作會導致其中一方變更時,
 * 既有斷字全數失效,且不會拋出錯誤。
 *
 * 本模組不 import 任何項目,亦無模組層級副作用,splitter.js 引用時不會連帶
 * 載入 kuroshiro。
 */

/*
 * 組合用長音符 U+0304。
 *
 * 以碼位指定而非直接寫入字元:組合字元單獨出現時於編輯器中不可見,
 * 編輯或複製時容易遺失,且從程式碼無法察覺。
 */
const COMBINING_MACRON = String.fromCharCode(0x0304);

/**
 * 移除長音符:ā ī ū ē ō → a i u e o
 *
 * kuroshiro 預設採 Hepburn 式,長音標為 ō / ē。畫面上呈現為母音上方的橫線,
 * 對跟唱並無助益。
 *
 * 採 Unicode 正規化而非逐字對照:NFD 會將 ō 拆為 o 加組合用長音符 U+0304,
 * 移除該組合字元即可涵蓋五個母音與大小寫,且不受 kuroshiro 輸出預組合字元
 * 或組合序列的影響。
 *
 * **長度必須維持不變**(一字元換一字元)。此為 splitter.js 沿用既有斷字的前提:
 * 斷點為字母索引,長度改變會使索引錯位。修改本函式時須保持此性質。
 *
 * 代價為長音資訊喪失(ō 與 o 無法區分)。此為刻意取捨,目標是可讀性
 * 而非嚴謹的轉寫。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMacrons(text) {
  return text.normalize('NFD').split(COMBINING_MACRON).join('').normalize('NFC');
}

/** 長音記號 U+30FC(ー)。延長前一個音,本身無讀音。 */
const PROLONG_MARK = 'ー';

/**
 * 移除未經轉換而落入羅馬拼音的長音記號。
 *
 * 辭典收錄的詞不會出現此情況(`ラーメン` 正確轉為 rāmen)。辭典未收錄的詞
 * (擬聲詞、造詞、歌詞中的特殊寫法)會退回逐字處理,而 ー 並非假名,
 * 無對應羅馬字,因而原樣輸出:
 *
 *   ひゅるひゅるりーらら  →  hi yuruhyururi ー ra ra
 *
 * 未處理會導致兩個問題:拼音中混入日文符號不易閱讀;且未轉換字的偵測會將其
 * 標記為紅色底線並提示補上讀音,但該符號本身沒有讀音。
 *
 * 採移除而非延長母音,是為與既有行為一致:stripMacrons 已將 rāmen 轉為 ramen,
 * 長音資訊本即未保留。若此處改為 hyururii,同一概念會有兩種表示方式。
 *
 * 保留長音的選項曾經評估並暫緩:作法為將 ー 替換為前一個母音
 * (hyururi ー → hyururii)。技術上可行,因假名的羅馬字多以母音結尾。
 * 風險在於結尾非母音的情況(ん 之後的 ー、跨越空白的 ー),該情況下疊出的字
 * 會是錯的,而顯示錯誤的拼音較缺少長音更糟。若日後實作,須先涵蓋這些邊界情況。
 *
 * **本函式會改變字串長度**,與 stripMacrons 相反(該函式須維持長度,
 * 手動斷字的索引依賴此性質)。兩者因此刻意分開,不可合併,否則會破壞
 * stripMacrons 的長度保證。
 *
 * @param {string} text 轉換後的羅馬拼音
 * @returns {string}
 */
export function stripProlongMarks(text) {
  if (!text.includes(PROLONG_MARK)) return text; // 多數句子走此路徑,不必處理字串

  return text
    .split(PROLONG_MARK)
    .join('')
    .replace(/\s{2,}/g, ' ') // 移除後可能留下連續空白
    .trim();
}
