/**
 * playback-clock.js
 * 取得目前的播放進度(毫秒)。
 *
 * 歌詞高亮需與歌聲同步,因此須知道當前的播放位置。以觀察 Spotify 畫面推斷句次的
 * 作法先天落後,且無法取得句子內部的進度 —— 逐字高亮需要該項資料。
 *
 * 實測結果(2026-08,Spotify 網頁版):
 *
 *   1. 頁面上沒有 <audio> 或 <video> 可供讀取 currentTime(querySelectorAll 回空陣列)
 *   2. [data-testid="playback-progressbar"] 沒有 aria-valuenow,亦無任何 [role="slider"]
 *      元素,沒有現成的數值可讀
 *   3. [data-testid="playback-position"] 的文字格式為 "0:25",僅有秒的精度
 *   4. 但文字跳動的時點準確:實測連續三次的間隔皆為 1.00 秒
 *
 * 因此以 MutationObserver 捕捉文字跳動作為基準點,其間以 performance.now() 內插,
 * 將精度自 1 秒提升至 100 毫秒以內。
 */

const LOG = '[romaji]';

const POSITION_SELECTOR = '[data-testid="playback-position"]';
const DURATION_SELECTOR = '[data-testid="playback-duration"]';

/** 超過此時間未跳動即判定為暫停(正常為每秒一次) */
const PAUSE_AFTER_MS = 1800;
/** 內插的上限。暫停或卡頓時避免誤差持續累積。 */
const MAX_INTERPOLATE_MS = 1100;
/** 位置變動超過此值即視為使用者拖動進度條,重新對齊 */
const SEEK_THRESHOLD_MS = 1500;
/** 確認觀察目標是否仍存在的間隔(React 會抽換元素) */
const REATTACH_MS = 500;

let observer = null;
let watchedEl = null;
let reattachTimer = null;

let domMs = null; // 畫面顯示的秒數,換算為毫秒
let stampedAt = 0; // 捕捉到該次跳動時的 performance.now()
let sawEdge = false; // 是否已捕捉到跳動(捕捉前精度僅有 1 秒)

/**
 * "0:25" / "4:03" / "1:02:03" → 毫秒。無法解析時回 null。
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

/** 記錄畫面讀取到的新秒數,並標上時間戳 */
function stamp(nextMs) {
  if (nextMs === null) return;

  const now = performance.now();
  const jumped = domMs !== null && Math.abs(nextMs - domMs) > SEEK_THRESHOLD_MS;

  // 拖動進度條後,原有的內插基準已失效,捨棄並重新建立
  if (jumped) sawEdge = false;
  // 首次讀取不計為跳動:僅得知當下顯示的秒數,無從判斷該值位於這一秒的起點或末端。
  // 須待實際觀察到變動,才能取得準確的基準點。
  else if (domMs !== null && nextMs !== domMs) sawEdge = true;

  domMs = nextMs;
  stampedAt = now;
}

/** 確認 observer 掛載於當前元素;React 抽換元素時須重新掛載 */
function ensureObserver() {
  const el = document.querySelector(POSITION_SELECTOR);
  if (el === watchedEl) return;

  observer?.disconnect();
  watchedEl = el;

  if (!el) {
    observer = null;
    return;
  }

  // 秒數以文字節點更新,characterData 不可省略;
  // 部分改版改為整批替換子節點,childList 亦須保留。
  observer = new MutationObserver(() => stamp(parseTime(el.textContent)));
  observer.observe(el, { characterData: true, childList: true, subtree: true });

  stamp(parseTime(el.textContent));
}

/* ----------------------------------------------------------- 對外介面 */

export function startClock() {
  if (reattachTimer) return; // 已啟動
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
 * 目前的播放位置(毫秒)。讀不到時回 null。
 *
 * 尚未捕捉到跳動時加上 500ms:畫面顯示 "0:25" 表示實際時間落在 25.000 至 26.000
 * 之間,取中間值的期望誤差最小。捕捉到跳動後改用內插,誤差可壓至 100ms 以內。
 */
export function getPositionMs() {
  if (domMs === null) return null;
  if (!sawEdge) return domMs + 500;

  const elapsed = performance.now() - stampedAt;
  return domMs + Math.min(elapsed, MAX_INTERPOLATE_MS);
}

/**
 * 目前是否正在播放。
 *
 * 依據為秒數是否持續跳動,而非播放鈕的文字 —— 該文字隨介面語言變動,
 * 比對任何固定字串都會在其他語言下失效。
 */
export function isPlaying() {
  if (domMs === null) return false;
  return performance.now() - stampedAt < PAUSE_AFTER_MS;
}

/** 曲目總長度(毫秒),用於比對 LRCLIB 搜尋結果的版本。 */
export function getDurationMs() {
  return parseTime(document.querySelector(DURATION_SELECTOR)?.textContent) ?? null;
}
