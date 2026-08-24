/**
 * numbers.js
 * 轉換前處理:將阿拉伯數字改寫為漢字數字。
 *
 * kuromoji 的辭典不處理阿拉伯數字,會將其視為無讀音的符號原樣輸出。
 * `50年を50億で買おう` 因而轉為 `50 nen o 50 oku de kao`。
 *
 * 採改寫為漢字而非直接拼寫假名,是因為量詞的讀法不規則:
 *
 *   一つ → ひとつ(非 いちつ)
 *   一人 → ひとり(非 いちにん)
 *   八日 → ようか(非 はちにち)
 *
 * 自行拼寫假名須逐一列舉這些規則,而遺漏不會拋出錯誤,僅會產生錯誤讀音。
 * 改寫為漢字後,`五十年`、`一つ` 皆為辭典收錄的詞,讀音由辭典決定。
 *
 * 本模組不 import 任何項目,可直接以 Node 測試。
 */

const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 四位數之內的位數 */
const SMALL_UNITS = ['', '十', '百', '千'];
/** 每四位一組的大單位 */
const BIG_UNITS = ['', '万', '億', '兆'];

/** 超過此長度不予改寫。該類數字多為電話、序號或帳號,並非用於朗讀。 */
const MAX_DIGITS = 16;

/** 將一組(至多四位)轉為漢字。回傳空字串表示該組為 0。 */
function groupToKanji(group) {
  let out = '';

  for (let i = 0; i < group.length; i += 1) {
    const digit = Number(group[group.length - 1 - i]);
    if (digit === 0) continue;

    const unit = SMALL_UNITS[i];
    /*
     * 十、百、千 之前的 1 須省略:10 為「十」而非「一十」。
     * 個位數的 1 須保留;1万 的一亦須保留,該情況於下方加上大單位時處理。
     */
    out = (digit === 1 && unit ? unit : DIGITS[digit] + unit) + out;
  }

  return out;
}

/** 整數字串轉漢字數字 */
function numberToKanji(digits) {
  if (/^0+$/.test(digits)) return '零';

  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.push(digits.slice(Math.max(0, end - 4), end));
  }

  let out = '';
  groups.forEach((group, index) => {
    const body = groupToKanji(group);
    if (!body) return; // 該組全為 0,連單位一併省略
    out = body + BIG_UNITS[index] + out;
  });

  return out;
}

/**
 * 將文字中的阿拉伯數字改寫為漢字數字。
 *
 * 三種情況不予改寫:
 *
 *   1. 前後緊鄰英文字母(mp3、Y2K)。該數字屬單字的一部分,非數量
 *   2. 前導為零且長度大於一(007、03:15)。多為編號或時間
 *   3. 長度超過 16 位
 *
 * @param {string} text 原始文字
 * @returns {string} 改寫後的文字;無數字時原樣回傳
 */
export function digitsToKanji(text) {
  if (!text) return text;

  return text.replace(/[0-9０-９]+/g, (run, offset, whole) => {
    const before = whole[offset - 1] ?? '';
    const after = whole[offset + run.length] ?? '';
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) return run;

    // 全形數字先轉為半形
    const digits = run.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

    if (digits.length > MAX_DIGITS) return run;
    if (digits.length > 1 && digits[0] === '0') return run;

    return numberToKanji(digits);
  });
}
