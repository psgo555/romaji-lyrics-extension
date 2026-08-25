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

/* ------------------------------------------------------------ 跳轉 */

/*
 * 設定播放位置。
 *
 * ── 為什麼是這個作法(2026-08 實測)────────────────────────────
 * 檔頭記載頁面沒有 <audio> 可設 currentTime,也沒有 [role="slider"]。
 * 但 [data-testid="playback-progressbar"] 內含一個隱藏的 <input type="range">
 * (Spotify 供鍵盤與輔助技術使用),實測其規格為:
 *
 *   min=0  max=274607  step=5000  aria-valuetext="2:14/4:34"
 *
 * max 即為精確至毫秒的曲目長度,設定 value 便會真正跳轉 ——
 * 實測自 3:25 跳至 0:33,確實生效,落點誤差在一秒以內。
 *
 * 另一條路是依座標模擬點擊進度條,已捨棄:那須換算像素,誤差約半秒,
 * 且視窗尺寸或版面一變就得重新對位。設定數值沒有這些問題。
 */
const PROGRESS_INPUT_SELECTOR = '[data-testid="playback-progressbar"] input[type="range"]';

/**
 * 將要跳往的位置夾在這首歌的範圍內。
 *
 * 抽為純函式是為了測得到 —— seekTo 其餘部分皆為 DOM 操作,
 * 而本專案的測試環境沒有 DOM。會被使用者看見的錯誤正出在此處:
 * 跳到負值或超過歌長,Spotify 的反應無從預期。
 *
 * @returns {number|null} null 代表這次不要跳
 */
export function clampSeekMs(ms, durationMs) {
  if (!Number.isFinite(ms)) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.round(Math.min(Math.max(ms, 0), durationMs));
}

/**
 * 跳至指定的播放位置(毫秒)。
 *
 * @param {number} ms 目標位置
 * @returns {boolean} 是否確實送出跳轉
 */
export function seekTo(ms) {
  const input = document.querySelector(PROGRESS_INPUT_SELECTOR);
  if (!input) return false;

  const target = clampSeekMs(ms, Number(input.max));
  if (target === null) return false;

  /*
   * step=5000 會將數值吸附至 5 秒的整數倍 —— 對「跳到某一句」而言過粗,
   * 誤差最大 2.5 秒,足以落在上一句或這一句的中段。
   * 暫時解除吸附,設定完再放回,不對頁面留下長期改動。
   */
  const previousStep = input.getAttribute('step');
  input.setAttribute('step', '1');

  try {
    /*
     * 一定要使用原生的 value setter,不可直接 input.value = x。
     *
     * React 會記錄它上次寫入的值,直接指派繞不過那層記錄 —— 它會判定
     * 數值沒有變化,於是把畫面轉回原狀,跳轉不會發生。
     * 取得原型上的 setter 再呼叫,才會被視為真正的外部輸入。
     */
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, String(target));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    console.warn(`${LOG} 跳轉失敗:`, err);
    return false;
  } finally {
    // 不論成敗都要還原,否則會連帶改掉 Spotify 自身鍵盤操作的粒度
    if (previousStep === null) input.removeAttribute('step');
    else input.setAttribute('step', previousStep);
  }

  return true;
}
