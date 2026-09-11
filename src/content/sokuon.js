/**
 * sokuon.js
 * 促音(っ / ッ)落在斷詞邊界時的處理。純函式,不 import 任何項目。
 *
 * kuroshiro 的 spaced 模式逐 token 轉換、以空格相接。促音若位於 token 尾端,
 * 與下一個字的子音分屬兩次轉換,無法合併為重複子音,會被單獨轉為 tsu:
 *
 *   だっ|た → datsu ta        なかっ|た → nakatsu ta
 *
 * kuroshiro 自身已有同樣的修補(util.js 的 patchTokens),但只套用於動詞與形容詞 ——
 * 分かっ|た 因此正確,助動詞的 だっ|た、なかっ|た 則不在其列。
 * 本模組將同一條規則延伸至所有詞性,在 kuroshiro 取得 token 之前先行合併。
 *
 * ── 未採「假名 + wanakana」的原因 ──────────────────────────
 * 曾評估改為先轉平假名、移除促音後的空格、再以 wanakana 轉為拼音。81 行歌詞的比對中,
 * 促音的 13 行修好,另有 33 行原本正確的輸出被改壞:kuroshiro 的拼音取自 token 的
 * 「發音」(は→ワ→wa、を→オ→o、よう→ヨー→yō),平假名輸出則是「讀音」(は、を、よう),
 * 經 wanakana 後成為 kimi ha、kokoro wo、you ni。發音資訊一旦捨棄便無從補回。
 * 本作法只改變斷詞,拼音仍由 kuroshiro 依發音產生,同一批比對中僅那 13 行改變。
 */

const SOKUON_TAIL = /[っッ]$/;
/** 平假名 ぁ–ゖ 與片假名 ァ–ヺ。ー 與標點不在其中 */
const KANA_HEAD = /^[ぁ-ゖァ-ヺ]/;

function isKnown(token) {
  return typeof token.reading === 'string' && typeof token.pronunciation === 'string';
}

/**
 * 將以促音結尾的 token 併入下一個 token。
 *
 * 合併方式與 kuroshiro 的 patchTokens 相同(表層、讀音、發音各自相接),
 * 其後的轉換因此與動詞、形容詞的情況走同一條路。三個條件缺一不可:
 *
 *   - 下一個 token 以假名開頭:促音後接標點或英文(「あっ、」)時沒有子音可合併,
 *     併起來只會把標點黏進詞裡
 *   - 兩者皆有讀音與發音:辭典未收錄的 token 缺這兩個欄位,kuroshiro 另有補值邏輯,
 *     在此硬併會產生 "undefined" 字串
 *   - 合併後仍以促音結尾者繼續往下併(行っ|ちゃっ|た → 行っちゃった)
 *
 * 句末的促音(あっ、ほらっ)沒有下一個 token,維持原樣。
 * 不修改傳入的 token。
 *
 * @param {object[]} tokens 形態素分析器的輸出(kuromoji 格式)
 * @returns {object[]}
 */
export function mergeSokuonTokens(tokens) {
  const merged = [];

  for (const token of tokens) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      SOKUON_TAIL.test(prev.surface_form) &&
      KANA_HEAD.test(token.surface_form) &&
      isKnown(prev) &&
      isKnown(token)
    ) {
      // prev 是本函式複製出來的物件,修改它不影響呼叫端
      prev.surface_form += token.surface_form;
      prev.reading += token.reading;
      prev.pronunciation += token.pronunciation;
      continue;
    }
    merged.push({ ...token });
  }

  return merged;
}

/**
 * 包裝形態素分析器,使其輸出先經 mergeSokuonTokens 處理。
 *
 * kuroshiro 只要求分析器具備 init() 與 parse(),以同樣的介面包一層即可,
 * 毋須修改或複製 kuroshiro 本身。拼音與平假名兩種轉換共用這個分析器,
 * 平假名模式的「だっ た」因此同樣成為「だった」。
 *
 * @param {{ init: () => Promise<void>, parse: (text: string) => Promise<object[]> }} analyzer
 */
export function withSokuonMerge(analyzer) {
  return {
    init: () => analyzer.init(),
    parse: async (text) => mergeSokuonTokens(await analyzer.parse(text)),
  };
}
