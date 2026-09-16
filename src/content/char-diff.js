/**
 * char-diff.js
 * 字元層級的對應:Myers 差異演算法(線性空間版,middle snake 分治)。
 * 純函式,不 import 任何項目,亦不觸及 DOM 與 chrome API(背景程式可安全引用)。
 *
 * 用途見 lyrics-align.js:兩份來源的同一首歌詞,斷行方式往往不同
 * (一方把兩句併成一行),逐句比對因此對不起來。改以整段文字逐字元對應,
 * 斷行差異即自動化解。
 *
 * ── 不建完整 LCS 表的原因 ──────────────────────────────────
 * LCS 表的記憶體是兩段長度的乘積。實測(2026-09,Chrome 152):
 * 最長的一首 Idol(2466 字)需 12MB,加長至 4932 字需 47MB。
 * Myers 的記憶體為 O(N+M):同樣的輸入為 0.23MB 與 0.55MB。
 *
 * ── 耗時(Chrome,括號為 CPU 降速 4 倍,約等於一般筆電) ──────────
 *   同一首歌、內容相符      ≤ 0.2ms(≤ 0.6ms)
 *   挑錯歌、同為拉丁字母    2.9ms(11.8ms)   ← 提前放棄後;不放棄為 53ms(230ms)
 *   兩段隨機假名(理論最壞) 4.5ms(19ms)     ← 提前放棄後;不放棄為 126ms(550ms)
 *
 * 實作參考 Neil Fraser 的 diff-match-patch(diff_bisect_),改為以索引操作、
 * 不切割字串,並將遞迴改為堆疊。
 */

/** bisect 超過編輯數上限時的回傳值 */
const OVER_LIMIT = 'over-limit';

/**
 * 字串 → 碼位陣列。
 *
 * 以碼位而非 UTF-16 單位切分:歌詞中偶有表情符號,逐個 UTF-16 單位比對會把
 * 代理對拆成兩半,對應結果落在半個字元上。
 *
 * @param {string} str
 * @returns {Int32Array}
 */
export function toCodes(str) {
  return Int32Array.from(Array.from(str), (c) => c.codePointAt(0));
}

/**
 * a 的每個位置對應到 b 的哪個位置。
 *
 * @param {Int32Array} a
 * @param {Int32Array} b
 * @param {{ minRatio?: number }} [options]
 *   minRatio:相符比例(對到的字數 / a 的長度)的門檻。給定時,一旦可確定達不到門檻
 *   即提前放棄。達得到門檻的輸入不會被放棄 —— 其編輯數必在上限內,而 middle snake
 *   於 d = ⌈D/2⌉ 時即可找到,不會走到上限。
 * @returns {{ map: Int32Array|null, matched: number, aborted: boolean }}
 *   map[i] 為 a 的第 i 個字元對應到 b 的位置,-1 表示沒有對應;
 *   matched 即最長共同子序列的長度(Myers 求的是最短編輯腳本);
 *   aborted 為 true 時 map 為 null。
 */
export function matchMap(a, b, { minRatio } = {}) {
  let dLimit = Infinity;
  if (minRatio) {
    const need = Math.ceil(minRatio * a.length);
    if (b.length < need) return { map: null, matched: -1, aborted: true };
    dLimit = Math.ceil((a.length + b.length - 2 * need) / 2) + 1;
  }

  const map = new Int32Array(a.length).fill(-1);
  let matched = 0;
  const stack = [[0, a.length, 0, b.length]];
  let first = true;

  while (stack.length) {
    let [aLo, aHi, bLo, bHi] = stack.pop();

    // 先削去頭尾相同的部分:多數情況兩段歌詞的開頭與結尾本就一致,
    // 削掉之後真正要搜尋的範圍會小得多
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      map[aLo] = bLo;
      aLo++;
      bLo++;
      matched++;
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi--;
      bHi--;
      map[aHi] = bHi;
      matched++;
    }
    if (aLo === aHi || bLo === bHi) continue;

    // 上限只需套在最外層:子問題的編輯數不會超過整體的編輯數
    const split = bisect(a, aLo, aHi, b, bLo, bHi, first ? dLimit : Infinity);
    first = false;
    if (split === OVER_LIMIT) return { map: null, matched: -1, aborted: true };
    if (!split) continue; // 這一段完全沒有共同字元

    const [x, y] = split;
    // 分割點必須讓範圍縮小,否則堆疊會反覆處理同一段而不終止
    if ((x === aLo && y === bLo) || (x === aHi && y === bHi)) throw new Error('bisect 沒有推進');
    stack.push([x, aHi, y, bHi], [aLo, x, bLo, y]);
  }

  return { map, matched, aborted: false };
}

/**
 * 找出中間的分割點(middle snake):自前後兩端同時推進,相遇處即為最短編輯路徑的中點。
 * 只保留兩條對角線陣列,記憶體因此與長度成正比,而非長度的乘積。
 */
function bisect(a, aLo, aHi, b, bLo, bHi, dLimit = Infinity) {
  const N = aHi - aLo;
  const M = bHi - bLo;
  const maxD = Math.ceil((N + M) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD;
  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = N - M;
  // 兩段長度差為奇數時,正向路徑會先與反向路徑相遇;為偶數則相反
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  for (let d = 0; d < maxD; d++) {
    if (d > dLimit) return OVER_LIMIT;

    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = vOffset + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < N && y1 < M && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > N) k1end += 2;
      else if (y1 > M) k1start += 2;
      else if (front) {
        const k2o = vOffset + delta - k1;
        if (k2o >= 0 && k2o < vLength && v2[k2o] !== -1 && x1 >= N - v2[k2o]) return [aLo + x1, bLo + y1];
      }
    }

    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = vOffset + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < N && y2 < M && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > N) k2end += 2;
      else if (y2 > M) k2start += 2;
      else if (!front) {
        const k1o = vOffset + delta - k2;
        if (k1o >= 0 && k1o < vLength && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = vOffset + x1 - k1o;
          if (x1 >= N - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }

  return null;
}
