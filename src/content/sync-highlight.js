/**
 * sync-highlight.js
 * 把 LRC 的時間軸對到畫面上的歌詞行,並做出「唱到哪、亮到哪」的效果。
 *
 * 為什麼不直接看 Spotify 的畫面:
 * 觀察畫面只能在 Spotify 更新完之後才知道換行了,先天就慢半拍,
 * 而且只知道「現在是第幾句」,拿不到句子內部的進度 ——
 * 逐字掃過去的效果需要後者。
 *
 * 改成用「播放到第幾毫秒」配上「每一句從第幾毫秒開始」來算,
 * 延遲趨近於零,而且句內進度是連續的。
 */

/**
 * 比對用的正規化。
 *
 * LRCLIB 的歌詞跟 Spotify 顯示的常有細微差異(空白、全形半形、標點),
 * 逐字元比對幾乎一定對不上,所以只留下有辨識度的部分。
 */
function normalize(text) {
  return (text ?? '')
    .normalize('NFKC') // 全形英數 → 半形,相容字 → 標準字
    .replace(/\s+/g, '')
    .replace(/[!-/:-@[-`{-~、-〟｡-･]/g, '') // 標點一律拿掉
    .toLowerCase();
}

/**
 * 把 LRC 的每一句對到畫面上的每一行。
 *
 * 用「照順序貪婪比對」而不是建一張 文字→時間 的表:
 * 副歌會重複出現一模一樣的句子,查表會全部對到第一次出現的時間。
 * 照順序走就不會有這個問題。
 *
 * @param {Array<{timeMs:number,text:string,words?:Array}>} lrcLines
 * @param {string[]} domTexts 畫面上每一行的原文
 * @returns {{ times: Array<number|null>, words: Array<Array|null>, matchRate: number }}
 *          times/words 都跟 domTexts 等長;matchRate 是有對到的比例
 */
export function alignLrc(lrcLines, domTexts) {
  const times = new Array(domTexts.length).fill(null);
  const words = new Array(domTexts.length).fill(null);
  if (!lrcLines?.length) return { times, words, matchRate: 0 };

  const lrcNorm = lrcLines.map((l) => normalize(l.text));

  let cursor = 0;
  let matched = 0;
  let comparable = 0;

  for (let i = 0; i < domTexts.length; i += 1) {
    const target = normalize(domTexts[i]);
    if (!target) continue; // 間奏空行不列入計算
    comparable += 1;

    // 只往前找有限範圍 —— Spotify 與 LRCLIB 的分行方式可能略有出入,
    // 給一點餘裕,但不能無限找,否則錯配會愈跑愈遠
    const limit = Math.min(lrcLines.length, cursor + 12);
    for (let k = cursor; k < limit; k += 1) {
      if (lrcNorm[k] !== target) continue;
      times[i] = lrcLines[k].timeMs;
      words[i] = lrcLines[k].words ?? null;
      cursor = k + 1;
      matched += 1;
      break;
    }
  }

  return { times, words, matchRate: comparable ? matched / comparable : 0 };
}

/**
 * 沒對到時間的行(通常是 LRC 少一句)用前後鄰居內插補起來,
 * 否則那一行永遠不會亮。
 *
 * 最後還會強制整個序列遞增。這一步不是可有可無的:
 * 對齊有誤差時可能產生前後顛倒的時間,而 activeIndexAt 是假設遞增在做判斷的
 * (遇到大於目前位置的就停),順序一亂就會提早停下來、**略過中間那幾句**。
 */
export function fillGaps(times) {
  const filled = [...times];

  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] !== null) continue;

    let prev = i - 1;
    while (prev >= 0 && filled[prev] === null) prev -= 1;
    let next = i + 1;
    while (next < filled.length && times[next] === null) next += 1;

    if (prev < 0 || next >= filled.length) continue; // 頭尾補不了就算了

    const span = times[next] - filled[prev];
    filled[i] = filled[prev] + (span * (i - prev)) / (next - prev);
  }

  // 保證遞增:任何比前一句還早的時間都夾到前一句
  let ceiling = -Infinity;
  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] === null) continue;
    if (filled[i] < ceiling) filled[i] = ceiling;
    else ceiling = filled[i];
  }

  return filled;
}

/**
 * 找出 positionMs 當下應該亮第幾行。
 * times 可能有 null(補不起來的行),要跳過。
 */
export function activeIndexAt(times, positionMs) {
  let found = -1;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] === null) continue;
    if (times[i] <= positionMs) found = i;
    else break;
  }
  return found;
}

/**
 * 這一行唱到幾成(0~1)。
 *
 * 掃描時間怎麼決定,兩個限制缺一不可:
 *
 * 1. spanFactor —— **平常以實際句距為準**。唱歌句中會有換氣、小停頓,
 *    真正的演唱時間比「字數×每字時間」估出來的長,所以不能用字數當主要依據,
 *    否則同一句還沒唱完字就掃完了。乘上略小於 1 的係數,讓掃描剛好在
 *    下一句開始前收尾。
 * 2. maxSpanMs —— **但句尾接長間奏時要擋住**。一句唱 2 秒卻隔 8 秒才接下一句的話,
 *    照句距掃就會拖成 8 秒、唱完才掃到四分之一。這時改由字數估算封頂。
 *
 * 兩者取小:一般情況第 1 條生效(停頓被自然吸收),遇到長間奏才輪到第 2 條。
 *
 * @param {Array<number|null>} times
 * @param {number} index
 * @param {number} positionMs
 * @param {{ fallbackMs?: number, maxSpanMs?: number, spanFactor?: number }} [options]
 */
export function progressAt(times, index, positionMs, options = {}) {
  if (index < 0 || times[index] === null) return 0;

  const { fallbackMs = 3500, maxSpanMs = Infinity, spanFactor = 1 } = options;

  const start = times[index];
  let next = index + 1;
  while (next < times.length && times[next] === null) next += 1;

  const end = next < times.length ? times[next] : start + fallbackMs;
  const span = Math.min((end - start) * spanFactor, maxSpanMs);
  if (span <= 0) return 1;

  return Math.min(1, Math.max(0, (positionMs - start) / span));
}

/**
 * 把逐字時間標籤變成一條「時間 → 進度」的折線。
 *
 * 進度用**原文字數的比例**當座標:LRC 的詞是日文,而畫面上的是羅馬拼音,
 * 兩者字數不同、也沒有一對一的對應關係。改用比例就不必去對每個字母
 * 屬於哪個詞 —— 只要每個詞在整句中佔的比例對,掃過去的位置就夠準了。
 *
 * @param {Array<{timeMs:number,text:string}>} words
 * @returns {Array<{timeMs:number,frac:number}>|null} 資料不足時回 null
 */
export function buildWordCurve(words) {
  if (!words?.length) return null;

  const total = words.reduce((sum, w) => sum + w.text.length, 0);
  if (!total) return null;

  let seen = 0;
  return words.map((w) => {
    const frac = seen / total;
    seen += w.text.length;
    return { timeMs: w.timeMs, frac };
  });
}

/**
 * 依折線算出目前進度(0~1)。兩個標籤之間用線性內插,所以掃描是連續的。
 *
 * @param {Array<{timeMs:number,frac:number}>} curve
 * @param {number} positionMs
 * @param {number} endMs 這一句結束的時間(下一句開始),用來算最後一個詞
 */
export function progressFromCurve(curve, positionMs, endMs) {
  if (!curve?.length) return null;
  if (positionMs <= curve[0].timeMs) return 0;

  for (let i = 0; i < curve.length - 1; i += 1) {
    if (positionMs >= curve[i + 1].timeMs) continue;

    const span = curve[i + 1].timeMs - curve[i].timeMs;
    const ratio = span > 0 ? (positionMs - curve[i].timeMs) / span : 1;
    return curve[i].frac + ratio * (curve[i + 1].frac - curve[i].frac);
  }

  // 最後一個詞唱到句尾
  const last = curve[curve.length - 1];
  const span = endMs - last.timeMs;
  const ratio = span > 0 ? Math.min(1, (positionMs - last.timeMs) / span) : 1;
  return last.frac + ratio * (1 - last.frac);
}

/**
 * 把「唱到哪」畫在拼音上。
 *
 * 直接在既有的逐字 <span> 上加 class,而不是另外蓋漸層遮罩 ——
 * 那些 span 本來就是手動切分功能建的,重用它們就不會跟
 * 點擊切分、hover 提示、鍵盤游標互相打架。
 *
 * @param {HTMLElement} lineEl 歌詞行
 * @param {number|null} progress 0~1;傳 null 代表這行不是正在唱的,全部清掉
 */
export function paintSweep(lineEl, progress) {
  const overlay = lineEl.querySelector(':scope > .romaji-overlay');
  if (!overlay) return;

  // progress 是 null 代表這一行不做逐字掃描(沒有逐字時間軸,或不是正在唱的那行)。
  // 拿掉標記讓 CSS 退回「整句一起亮」—— 沒有資料就不要假裝有。
  if (progress === null) {
    if (overlay.dataset.romajiSweep) delete overlay.dataset.romajiSweep;
    for (const span of overlay.querySelectorAll('.romaji-ch.is-sung')) {
      span.classList.remove('is-sung');
    }
    return;
  }

  const chars = overlay.querySelectorAll('.romaji-ch');
  if (!chars.length) return;

  if (overlay.dataset.romajiSweep !== '1') overlay.dataset.romajiSweep = '1';

  const sung = Math.round(progress * chars.length);

  // 只在有變化時才動 DOM —— 這個函式每幾十毫秒就跑一次。
  //
  // 比對的是**畫面上實際的狀態**而不是自己記的數字:重新轉換那一行時
  // renderRomaji 會整批換掉這些 span,class 跟著沒了。
  // 如果只信自己記的數字,就會誤判「沒變化」而不重畫,高亮就消失了。
  const painted = overlay.querySelectorAll('.romaji-ch.is-sung').length;
  if (painted === sung) return;

  chars.forEach((span, i) => {
    const isSung = i < sung;
    if (isSung !== span.classList.contains('is-sung')) {
      span.classList.toggle('is-sung', isSung);
    }
  });
}
