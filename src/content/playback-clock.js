/**
 * playback-clock.js
 * 取得目前的播放進度(毫秒)。
 *
 * 為什麼需要:要讓歌詞高亮跟上歌聲,就得知道「現在播到第幾秒」。
 * 用觀察 Spotify 畫面的方式去推斷「現在唱到第幾句」先天就會慢半拍,
 * 而且完全拿不到句子內部的進度(逐字掃過去的效果需要那個)。
 *
 * ── 實測紀錄(2026-08,Spotify 網頁版)────────────────────────────
 * 1. 頁面上**沒有** <audio>/<video> 可以讀 currentTime(querySelectorAll 回空陣列)
 * 2. [data-testid="playback-progressbar"] **沒有** aria-valuenow,只有 class,
 *    也找不到任何 [role="slider"] 元素 —— 沒有現成的數值可讀
 * 3. [data-testid="playback-position"] 的文字是 "0:25" 這種格式,只有秒的精度
 * 4. 但文字**跳動的瞬間**很準:實測連續三次間隔都正好 1.00 秒
 *
 * 所以策略是:用 MutationObserver 抓文字跳動的那一刻當基準點,
 * 中間用 performance.now() 內插。精度可以從 1 秒補到 100 毫秒以內。
 */

const LOG = '[romaji]';

const POSITION_SELECTOR = '[data-testid="playback-position"]';
const DURATION_SELECTOR = '[data-testid="playback-duration"]';

/** 超過這麼久沒跳動就判定為暫停(正常是每秒跳一次) */
const PAUSE_AFTER_MS = 1800;
/** 內插最多補這麼多,避免暫停或卡頓時愈飄愈遠 */
const MAX_INTERPOLATE_MS = 1100;
/** 位置變動超過這麼多就當作使用者拖動了進度條,重新對齊 */
const SEEK_THRESHOLD_MS = 1500;
/** 多久確認一次觀察目標還在(React 會抽換元素) */
const REATTACH_MS = 500;

let observer = null;
let watchedEl = null;
let reattachTimer = null;

let domMs = null; // 畫面上顯示的秒數換算成毫秒
let stampedAt = 0; // 抓到那次跳動時的 performance.now()
let sawEdge = false; // 有沒有抓到過真正的跳動(還沒抓到時精度只有 1 秒)

/**
 * "0:25" / "4:03" / "1:02:03" → 毫秒。認不得就回 null。
 */
export function parseTime(text) {
  if (!text) return null;
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const numbers = parts.map((p) => Number(p.trim()));
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;

  const [h, m, s] = parts.length === 3 ? numbers : [0, numbers[0], numbers[1]];
  return (h * 3600 + m * 60 + s) * 1000;
}

/** 把畫面上讀到的新秒數記下來,並蓋上時間戳 */
function stamp(nextMs) {
  if (nextMs === null) return;

  const now = performance.now();
  const jumped = domMs !== null && Math.abs(nextMs - domMs) > SEEK_THRESHOLD_MS;

  // 拖動進度條之後舊的內插基準完全沒有意義,直接丟掉重來
  if (jumped) sawEdge = false;
  // 第一次讀到不算「跳動」—— 我們只知道它顯示這個秒數,
  // 不知道是這一秒的開頭還是結尾。要等真的看到它變才有準確的基準點。
  else if (domMs !== null && nextMs !== domMs) sawEdge = true;

  domMs = nextMs;
  stampedAt = now;
}

/** 確認 observer 掛在目前這顆元素上;React 換掉它時要重掛 */
function ensureObserver() {
  const el = document.querySelector(POSITION_SELECTOR);
  if (el === watchedEl) return;

  observer?.disconnect();
  watchedEl = el;

  if (!el) {
    observer = null;
    return;
  }

  // 秒數是直接改文字節點,所以 characterData 不能省;
  // 但有些改版是整個換掉子節點,所以 childList 也要留著。
  observer = new MutationObserver(() => stamp(parseTime(el.textContent)));
  observer.observe(el, { characterData: true, childList: true, subtree: true });

  stamp(parseTime(el.textContent));
}

/* ----------------------------------------------------------- 對外介面 */

export function startClock() {
  if (reattachTimer) return; // 已經在跑了
  ensureObserver();
  reattachTimer = setInterval(ensureObserver, REATTACH_MS);
  console.info(`${LOG} 播放時鐘啟動(來源:playback-position 文字 + 內插)`);
}

export function stopClock() {
  clearInterval(reattachTimer);
  reattachTimer = null;
  observer?.disconnect();
  observer = null;
  watchedEl = null;
  domMs = null;
  sawEdge = false;
}

/**
 * 目前播放位置(毫秒)。讀不到時回 null。
 *
 * 還沒抓到跳動邊緣時會加 500ms —— 畫面顯示 "0:25" 代表真實時間
 * 落在 25.000~26.000 之間,取中間值的誤差期望值最小。
 * 抓到邊緣之後就改用真正的內插,誤差可以壓到 100ms 以內。
 */
export function getPositionMs() {
  if (domMs === null) return null;
  if (!sawEdge) return domMs + 500;

  const elapsed = performance.now() - stampedAt;
  return domMs + Math.min(elapsed, MAX_INTERPOLATE_MS);
}

/**
 * 現在是不是正在播放。
 *
 * 判斷方式是「秒數還有沒有在跳」,不去讀播放鈕的文字 ——
 * 那個是跟著介面語言變的,寫死任何字串都會在別的語言下壞掉。
 */
export function isPlaying() {
  if (domMs === null) return false;
  return performance.now() - stampedAt < PAUSE_AFTER_MS;
}

/** 這首歌的總長度(毫秒)。拿去跟 LRCLIB 的搜尋結果比對版本用的。 */
export function getDurationMs() {
  return parseTime(document.querySelector(DURATION_SELECTOR)?.textContent) ?? null;
}
