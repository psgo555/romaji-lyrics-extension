/**
 * numbers.js
 * 把阿拉伯數字換成漢字數字,轉換前的前處理。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────
 * kuromoji 的辭典不處理阿拉伯數字。它認得「五十」,但看到「50」只當成
 * 一個沒有讀音的符號原樣放行 —— 於是「50年を50億で買おう」轉出來是
 * 「50 nen o 50 oku de kao」,而跟唱的人根本不知道那要唸什麼。
 *
 * ── 為什麼是換成漢字,不是自己拼假名 ──────────────────────────
 * 因為**量詞的讀法很不規則**,而那些規則 kuromoji 的辭典裡本來就有:
 *
 *   一つ → ひとつ(不是 いちつ)
 *   一人 → ひとり(不是 いちにん)
 *   八日 → ようか(不是 はちにち)
 *
 * 自己拼假名的話,這些全部要自己列 —— 那是個無底洞,而且列漏了不會報錯,
 * 只會安靜地唸錯。換成漢字之後「五十年」「一つ」都是辭典查得到的詞,
 * 讀音由它負責,我們只要把數字寫對。
 *
 * 這支不 import 任何東西,所以 Node 測得到。
 */

const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 一組四位數之內的位數 */
const SMALL_UNITS = ['', '十', '百', '千'];
/** 每四位一組的大單位 */
const BIG_UNITS = ['', '万', '億', '兆'];

/** 超過這個長度就不換 —— 那多半是電話、序號、帳號,不是要唸出來的數 */
const MAX_DIGITS = 16;

/** 把一組(最多四位)轉成漢字。回空字串代表這一組是 0。 */
function groupToKanji(group) {
  let out = '';

  for (let i = 0; i < group.length; i += 1) {
    const digit = Number(group[group.length - 1 - i]);
    if (digit === 0) continue;

    const unit = SMALL_UNITS[i];
    /*
     * 十/百/千 前面的 1 要省略:10 是「十」不是「一十」,100 是「百」。
     * 個位數的 1 要留(「一」);1万 的那個一也要留,不過那是下面加大單位時
     * 的事,這裡只管四位數之內。
     */
    out = (digit === 1 && unit ? unit : DIGITS[digit] + unit) + out;
  }

  return out;
}

/** 整數字串 → 漢字數字 */
function numberToKanji(digits) {
  if (/^0+$/.test(digits)) return '零';

  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.push(digits.slice(Math.max(0, end - 4), end));
  }

  let out = '';
  groups.forEach((group, index) => {
    const body = groupToKanji(group);
    if (!body) return; // 這一組全是 0,連單位都不要寫
    out = body + BIG_UNITS[index] + out;
  });

  return out;
}

/**
 * 把文字裡的阿拉伯數字換成漢字數字。
 *
 * 三種情況刻意不換 —— 換了只會更糟:
 *
 *   1. 前後緊接著英文字母(mp3、Y2K、24k)。那是單字的一部分,不是數量。
 *   2. 開頭是 0 而且不只一位(007、03:15)。那多半是編號或時間,
 *      「007」唸成「七」很奇怪。
 *   3. 長到不像是要唸出來的(超過 16 位)。
 *
 * @param {string} text 原始文字
 * @returns {string} 換過的文字;沒有數字時原樣回傳
 */
export function digitsToKanji(text) {
  if (!text) return text;

  return text.replace(/[0-9０-９]+/g, (run, offset, whole) => {
    const before = whole[offset - 1] ?? '';
    const after = whole[offset + run.length] ?? '';
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) return run;

    // 全形數字先轉成半形再算
    const digits = run.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

    if (digits.length > MAX_DIGITS) return run;
    if (digits.length > 1 && digits[0] === '0') return run;

    return numberToKanji(digits);
  });
}
