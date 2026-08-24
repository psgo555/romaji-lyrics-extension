/**
 * sync-highlight.js
 * 將 LRC 時間軸對應至畫面上的歌詞行,並產生逐字掃描的高亮效果。
 *
 * 不採觀察 Spotify 畫面的作法:該方式須待 Spotify 更新完成後才能得知換行,
 * 先天落後,且僅能取得目前句次,無法取得句子內部的進度 —— 逐字掃描需要後者。
 *
 * 改以「播放位置(毫秒)」搭配「每句的起始毫秒」計算,延遲趨近於零,
 * 且句內進度為連續值。
 */

/**
 * 比對用的正規化。
 *
 * LRCLIB 的歌詞與 Spotify 顯示的內容常有細微差異(空白、全形半形、標點),
 * 逐字元比對幾乎必然失敗,因而僅保留具辨識度的部分。
 */
function normalize(text) {
  return (text ?? '')
    .normalize('NFKC') // 全形英數 → 半形,相容字 → 標準字
    .replace(/\s+/g, '')
    .replace(/[!-/:-@[-`{-~、-〟｡-･]/g, '') // 一律移除標點
    .toLowerCase();
}

/**
 * 將 LRC 的每一句對應至畫面上的每一行。
 *
 * 採依序貪婪比對,而非建立「文字 → 時間」的對照表:副歌會重複出現完全相同的
 * 句子,查表會將其全部對應至首次出現的時間。依序推進即無此問題。
 *
 * @param {Array<{timeMs:number,text:string,words?:Array}>} lrcLines
 * @param {string[]} domTexts 畫面上每一行的原文
 * @returns {{ times: Array<number|null>, words: Array<Array|null>, matchRate: number }}
 *          times 與 words 皆與 domTexts 等長;matchRate 為成功對應的比例
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

    // 僅向前搜尋有限範圍:Spotify 與 LRCLIB 的分行方式可能略有出入,須保留餘裕,
    // 但不可無限搜尋,否則錯誤配對會持續擴大
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
 * 以前後鄰居內插補齊未對應到時間的行(通常為 LRC 缺少一句),
 * 否則該行永遠不會高亮。
 *
 * 最後強制整個序列遞增。此步驟不可省略:對齊誤差可能產生前後顛倒的時間,
 * 而 activeIndexAt 是以遞增為前提進行判斷(遇到大於目前位置者即停止),
 * 順序一旦錯亂便會提前停止,略過中間數句。
 */
export function fillGaps(times) {
  const filled = [...times];

  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] !== null) continue;

    let prev = i - 1;
    while (prev >= 0 && filled[prev] === null) prev -= 1;
    let next = i + 1;
    while (next < filled.length && times[next] === null) next += 1;

    if (prev < 0 || next >= filled.length) continue; // 首尾無從補齊

    const span = times[next] - filled[prev];
    filled[i] = filled[prev] + (span * (i - prev)) / (next - prev);
  }

  // 保證遞增:早於前一句的時間一律夾至前一句
  let ceiling = -Infinity;
  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] === null) continue;
    if (filled[i] < ceiling) filled[i] = ceiling;
    else ceiling = filled[i];
  }

  return filled;
}

/**
 * 取得 positionMs 當下應高亮的行。
 * times 可能含 null(無法補齊的行),須略過。
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
 * 該行的完成比例(0~1)。
 *
 * 掃描時間由兩項限制共同決定,缺一不可:
 *
 *   1. spanFactor —— 平常以實際句距為準。演唱時句中含換氣與停頓,實際演唱時間
 *      長於「字數 × 每字時間」的估算值,因此不可以字數為主要依據,否則該句尚未
 *      唱完掃描即已結束。乘上略小於 1 的係數,使掃描恰於下一句開始前收尾。
 *   2. maxSpanMs —— 句尾接續長間奏時須設上限。一句演唱 2 秒卻相隔 8 秒才接下一句
 *      時,依句距掃描會拖長至 8 秒,整句唱完僅掃描四分之一。此時改由字數估算封頂。
 *
 * 兩者取小:一般情況由第 1 項生效(停頓被自然吸收),遇長間奏才由第 2 項接手。
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
 * 將逐字時間標籤轉為一條「時間 → 進度」的折線。
 *
 * 進度以原文字數的比例作為座標:LRC 的詞為日文,畫面上的則是羅馬拼音,兩者字數
 * 不同,亦無一對一的對應關係。改用比例後即無須判定每個字母屬於哪個詞 ——
 * 只要各詞於整句中所佔的比例正確,掃描位置即足夠準確。
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
 * 依折線計算目前進度(0~1)。兩個標籤之間採線性內插,掃描因而為連續。
 *
 * @param {Array<{timeMs:number,frac:number}>} curve
 * @param {number} positionMs
 * @param {number} endMs 該句結束的時間(下一句開始),用於計算最後一個詞
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

  // 最後一個詞延續至句尾
  const last = curve[curve.length - 1];
  const span = endMs - last.timeMs;
  const ratio = span > 0 ? Math.min(1, (positionMs - last.timeMs) / span) : 1;
  return last.frac + ratio * (1 - last.frac);
}

/**
 * 將演唱進度繪製於拼音上。
 *
 * 直接於既有的逐字 <span> 加上 class,而非另外覆蓋漸層遮罩 —— 那些 span 本即由
 * 手動切分功能建立,重用可避免與點擊切分、hover 提示及鍵盤游標互相干擾。
 *
 * @param {HTMLElement} lineEl 歌詞行
 * @param {number|null} progress 0~1;傳入 null 表示該行非演唱中,清除全部標記
 */
export function paintSweep(lineEl, progress) {
  const overlay = lineEl.querySelector(':scope > .romaji-overlay');
  if (!overlay) return;

  // progress 為 null 表示該行不進行逐字掃描(無逐字時間軸,或非演唱中的行)。
  // 移除標記使 CSS 退回整句一併高亮 —— 沒有資料即不應假裝具備。
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

  // 僅於狀態變動時操作 DOM —— 本函式每數十毫秒執行一次。
  //
  // 比對的對象是畫面上的實際狀態而非自行記錄的數值:重新轉換該行時,
  // renderRomaji 會整批替換這些 span,class 隨之消失。若僅信任自行記錄的數值,
  // 便會誤判為無變動而不重繪,高亮因而消失。
  const painted = overlay.querySelectorAll('.romaji-ch.is-sung').length;
  if (painted === sung) return;

  chars.forEach((span, i) => {
    const isSung = i < sung;
    if (isSung !== span.classList.contains('is-sung')) {
      span.classList.toggle('is-sung', isSung);
    }
  });
}
