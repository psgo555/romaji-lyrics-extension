/**
 * lrc-panel.js
 * Spotify 沒有歌詞時,用 LRCLIB 的歌詞自己浮一個面板出來。
 *
 * 為什麼需要:有些歌 Spotify 根本不提供歌詞(授權沒談成、冷門曲目),
 * 這時原本的整條流程都沒有東西可以掛 —— 沒有歌詞行,就沒有拼音。
 * service worker 早就會去 LRCLIB 把歌詞抓回來了,只是先前沒有地方顯示。
 *
 * ── 這個面板刻意做的一個決定 ──────────────────────────────
 * 面板的每一行**做成跟 Spotify 歌詞行同構的元素**:
 *
 *   <li data-romaji-source="原文">
 *     <span class="romaji-original">原文</span>
 *     <span class="romaji-overlay">…逐字 span…</span>
 *   </li>
 *
 * 這樣一來,顯示模式的 CSS、手動切分的點擊委派、補讀音面板、
 * 逐字掃描的 paintSweep —— 全部原封不動就能用在面板上,
 * 一行都不用為面板重寫。轉換本身也交還給 index.js 的既有佇列,
 * 這裡只負責「把行擺出來」跟「現在唱到哪」。
 *
 * 連手動切分都是共用的:key 是原始日文歌詞行,所以同一句歌詞
 * 在 Spotify 歌詞上切過的空格,在這個面板上也會直接生效。
 */

import {
  activeIndexAt,
  progressAt,
  progressFromCurve,
  buildWordCurve,
  paintSweep,
} from './sync-highlight.js';
import { clampToViewport } from './drag-bounds.js';

const LOG = '[romaji]';

const PANEL_CLASS = 'romaji-lrc-panel';
const LINE_CLASS = 'romaji-lrc-line';

/**
 * 使用者自己捲動之後,先別跟他搶。
 *
 * 沒有這段的話,想往回看前面幾句是辦不到的 —— 每 80ms 的更新
 * 會立刻把畫面拉回正在唱的那一句,手感像是被面板甩開。
 */
const USER_SCROLL_GRACE_MS = 4000;

let panelEl = null;
let bodyEl = null;
let lineEls = [];

/** 跟 lineEls 一一對應的起始時間;沒有時間軸(只有純文字歌詞)時是 null */
let times = null;
/** 跟 lineEls 一一對應的逐字進度折線,沒有逐字資料的行是 null */
let curves = [];

let lastActive = -1;
let userScrolledAt = 0;
let onCloseCallback = null;

/* -------------------------------------------------------------- 拖曳 */

/*
 * 為什麼要能拖:面板固定在右上角,而 Chrome 的擴充功能設定視窗**一定**
 * 也在右上角(那是瀏覽器決定的,改不了)。兩個一定會疊在一起,
 * 使用者一開設定就看不到歌詞。
 *
 * 為什麼不是「自動放到 Spotify 中間那塊」:那要靠猜它的版面結構,
 * 而這個擴充功能已經被 Spotify 改版打壞過一次。讓使用者自己放,
 * 不依賴任何選擇器,它改版幾次都不會壞。
 */

const POSITION_KEY = 'lrcPanelPos';

let dragging = null;

function enableDrag(panel, handle, closeButton) {
  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || closeButton.contains(event.target)) return;
    event.preventDefault(); // 不要讓瀏覽器把標題文字選起來

    const rect = panel.getBoundingClientRect();
    /*
     * 面板原本是靠 top/right/bottom 撐出高度的。改用 left/top 定位之前,
     * 必須先把高度固定下來 —— 否則 bottom 一放掉,面板會縮成標題列那麼高。
     */
    panel.style.height = `${rect.height}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;

    dragging = { panel, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  });
}

function onDragMove(event) {
  if (!dragging) return;
  const { panel, offsetX, offsetY } = dragging;
  const rect = panel.getBoundingClientRect();

  const next = clampToViewport(
    { left: event.clientX - offsetX, top: event.clientY - offsetY },
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  );

  panel.style.left = `${next.left}px`;
  panel.style.top = `${next.top}px`;
}

function onDragEnd() {
  if (!dragging) return;
  dragging = null;
  saveLayout();
}

/**
 * 記住位置與大小。
 *
 * 存不進去也沒關係 —— 下次回到預設位置而已,不值得打擾使用者。
 */
let saveTimer = null;
function saveLayout() {
  if (!panelEl) return;
  const rect = panelEl.getBoundingClientRect();
  const layout = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };

  /*
   * 節流。拉伸的時候 ResizeObserver 每一幀都會叫一次,
   * 一次拖曳就是上百次寫入 —— storage 有寫入頻率上限,
   * 灌爆之後**其他功能的儲存也會一起失敗**(自訂讀音就是這樣壞過一次)。
   */
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [POSITION_KEY]: layout }).catch(() => {});
  }, 400);
}

/*
 * 掛在 document 上而不是面板上:放開滑鼠的時候游標常常已經離開面板了
 * (拖得比較快的時候),掛在面板上會收不到那一下,面板就黏在游標上。
 */
document.addEventListener('mousemove', onDragMove);
document.addEventListener('mouseup', onDragEnd);

/** 視窗變小時,把面板拉回看得到的地方 */
window.addEventListener('resize', () => {
  if (!panelEl || panelEl.style.left === '') return;
  const rect = panelEl.getBoundingClientRect();
  const next = clampToViewport(
    { left: rect.left, top: rect.top },
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  );
  panelEl.style.left = `${next.left}px`;
  panelEl.style.top = `${next.top}px`;
});

/**
 * 盯著面板被拉大縮小。
 *
 * 用 ResizeObserver 而不是聽某個事件:右下角的拉伸把手是瀏覽器內建的,
 * 它不會發出任何我們攔得到的事件 —— 只看得到「大小變了」這個結果。
 */
let sizeObserver = null;
function watchResize(panel) {
  sizeObserver?.disconnect();
  sizeObserver = new ResizeObserver(() => {
    // 拖曳中不要存:那時候位置每一幀都在變,等放開再存一次就好
    if (!dragging) saveLayout();
  });
  sizeObserver.observe(panel);
}

/** 還原上次拖到的位置與大小。沒存過就維持 CSS 的預設值。 */
async function restorePosition(panel) {
  try {
    const stored = await chrome.storage.local.get(POSITION_KEY);
    const saved = stored[POSITION_KEY];
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;

    const rect = panel.getBoundingClientRect();
    // 舊版的紀錄沒有 width,少了就沿用目前的,不要整筆丟掉
    const width = Number.isFinite(saved.width) ? saved.width : rect.width;
    const height = Number.isFinite(saved.height) ? saved.height : rect.height;

    // 存的時候畫面可能比現在大,所以還原時要再夾一次
    const next = clampToViewport(
      { left: saved.left, top: saved.top },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight }
    );

    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
  } catch {
    // 讀不到就用預設位置,不是值得中斷的事
  }
}

/* ------------------------------------------------------------ 建立面板 */

function buildShell(title, subtitle) {
  const panel = document.createElement('aside');
  panel.className = PANEL_CLASS;
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'LRCLIB 歌詞');

  const head = document.createElement('header');
  head.className = 'romaji-lrc-head';

  const titles = document.createElement('div');
  titles.className = 'romaji-lrc-titles';

  const titleEl = document.createElement('div');
  titleEl.className = 'romaji-lrc-title';
  titleEl.textContent = title;

  const subEl = document.createElement('div');
  subEl.className = 'romaji-lrc-sub';
  subEl.textContent = subtitle;

  titles.append(titleEl, subEl);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'romaji-lrc-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '關閉歌詞面板');
  close.addEventListener('click', () => {
    const cb = onCloseCallback;
    closeLrcPanel();
    cb?.();
  });

  head.append(titles, close);
  enableDrag(panel, head, close);

  const body = document.createElement('ol');
  body.className = 'romaji-lrc-body';

  /*
   * 捲動事件分不出「使用者捲的」跟「我們自己捲的」,
   * 所以自動捲動時會先把 userScrolledAt 往回撥(見 scrollToActive),
   * 這裡收到的就只剩下真的是使用者操作的那些。
   */
  body.addEventListener(
    'scroll',
    () => {
      userScrolledAt = performance.now();
    },
    { passive: true }
  );

  panel.append(head, body);
  return { panel, body };
}

/**
 * 把一行歌詞做成 <li>。
 *
 * 刻意只放**純文字**,不在這裡做轉換 —— 拼音是由 index.js 的佇列
 * 統一處理的(它會 ensureOriginalWrapper 把文字包進 .romaji-original,
 * 再把拼音填進 .romaji-overlay)。同一套流程處理兩種來源,
 * 就不會出現「Spotify 那邊修好了、面板這邊還是舊行為」。
 */
function buildLine(text) {
  const li = document.createElement('li');
  li.className = LINE_CLASS;
  // 間奏行(只有時間沒有文字)要留著佔位,否則高亮會卡在上一句
  li.textContent = text || '';
  return li;
}

/* ------------------------------------------------------------ 對外介面 */

/**
 * 打開面板。重複呼叫會整個重建(換歌時就是這樣)。
 *
 * @param {object} options
 * @param {string} options.title    面板標題(曲名)
 * @param {string} options.subtitle 副標(歌手 + 來源)
 * @param {Array<{timeMs:number,text:string,words?:Array}>|null} options.timed
 *        有時間軸的歌詞。有這個才做得出高亮與逐字掃描。
 * @param {string[]|null} options.plain
 *        只有純文字的歌詞。沒有時間軸時的退路,只顯示不高亮。
 * @param {() => void} [options.onClose] 使用者按叉叉時的回呼
 * @returns {HTMLElement[]} 建好的行元素,呼叫端要把它們送進轉換佇列
 */
export function openLrcPanel({ title, subtitle, timed, plain, onClose }) {
  closeLrcPanel();

  const source = timed?.length ? timed : (plain ?? []).map((text) => ({ timeMs: null, text }));
  if (!source.length) return [];

  const shell = buildShell(title, subtitle);
  panelEl = shell.panel;
  bodyEl = shell.body;
  onCloseCallback = onClose ?? null;

  lineEls = source.map((line) => {
    const el = buildLine(line.text);
    bodyEl.appendChild(el);
    return el;
  });

  times = timed?.length ? source.map((l) => l.timeMs) : null;
  curves = timed?.length ? source.map((l) => buildWordCurve(l.words)) : [];

  lastActive = -1;
  userScrolledAt = 0;

  document.body.appendChild(panelEl);
  // 位置是非同步讀回來的,所以面板會先出現在預設位置再跳過去 ——
  // 那一下比「等讀完才顯示」好:歌詞晚出現才是使用者真的在意的事
  restorePosition(panelEl);
  watchResize(panelEl);

  const withWords = curves.filter(Boolean).length;
  console.info(
    `${LOG} LRCLIB 歌詞面板已開啟,${lineEls.length} 行` +
      (times
        ? `,有時間軸${withWords ? `,其中 ${withWords} 句有逐字時間軸` : ''}`
        : ',只有純文字歌詞,不做高亮')
  );

  return lineEls;
}

export function closeLrcPanel() {
  // 面板都要移除了,還盯著它看只是留一個沒人管的觀察者
  sizeObserver?.disconnect();
  sizeObserver = null;
  clearTimeout(saveTimer);

  panelEl?.remove();
  panelEl = null;
  bodyEl = null;
  lineEls = [];
  times = null;
  curves = [];
  lastActive = -1;
  onCloseCallback = null;
}

export function isLrcPanelOpen() {
  return panelEl !== null;
}

/** 面板上的行元素。index.js 的佇列要拿它來決定先轉哪一行。 */
export function getPanelLineElements() {
  return lineEls;
}

/**
 * 面板被頁面重建洗掉時重新掛回去。
 *
 * Spotify 是 React SPA,理論上不會動到我們 append 在 body 最後的元素,
 * 但它換頁時確實有整批清理的動作。每秒確認一次很便宜,
 * 而萬一真的掉了卻不補,使用者看到的就是「面板莫名其妙消失」。
 */
export function ensurePanelAttached() {
  if (panelEl && !panelEl.isConnected) document.body.appendChild(panelEl);
}

/**
 * 更新「現在唱到哪一行、唱到哪個字」。
 *
 * @param {number|null} positionMs 已經套用過提前量的播放位置
 * @param {{ sweepMsPerLetter?: number, spanFactor?: number }} [options]
 */
export function updateLrcPanel(positionMs, options = {}) {
  if (!panelEl || !times || positionMs === null) return;

  const active = activeIndexAt(times, positionMs);

  let progress = null;
  if (active >= 0) {
    const curve = curves[active];
    if (curve) {
      progress = progressFromCurve(curve, positionMs, nextTimeAfter(active));
    } else {
      const letters = countLetters(lineEls[active]);
      progress = progressAt(times, active, positionMs, {
        spanFactor: options.spanFactor ?? 1,
        maxSpanMs:
          letters && options.sweepMsPerLetter ? letters * options.sweepMsPerLetter : Infinity,
      });
    }
  }

  lineEls.forEach((el, i) => {
    if (i === active) {
      if (el.dataset.romajiActive !== 'true') el.dataset.romajiActive = 'true';
      paintSweep(el, progress);
    } else {
      if (el.dataset.romajiActive) delete el.dataset.romajiActive;
      paintSweep(el, null);
    }
  });

  if (active !== lastActive) {
    lastActive = active;
    if (active >= 0) scrollToActive(lineEls[active]);
  }
}

/* ------------------------------------------------------------------ 內部 */

/** 這一句唱到什麼時候結束(下一句開始)。最後一句沒有下一句就給個合理長度。 */
function nextTimeAfter(index) {
  for (let i = index + 1; i < times.length; i += 1) {
    if (times[i] !== null) return times[i];
  }
  return times[index] + 4000;
}

function countLetters(lineEl) {
  const overlay = lineEl?.querySelector(':scope > .romaji-overlay');
  return overlay ? overlay.querySelectorAll('.romaji-ch').length : 0;
}

/**
 * 把正在唱的那一句捲到面板中間偏上的位置。
 *
 * 為什麼是偏上而不是正中間:跟唱的人要看的是**接下來**幾句,
 * 已經唱過的留一兩行當定位參考就夠了。
 */
function scrollToActive(lineEl) {
  if (!bodyEl || !lineEl) return;

  // 使用者剛剛自己捲過就先不要搶,等他停手一段時間
  if (performance.now() - userScrolledAt < USER_SCROLL_GRACE_MS) return;

  const target = lineEl.offsetTop - bodyEl.clientHeight * 0.38;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * 先把「使用者捲動」的時間戳往回撥,再自己捲。
   *
   * scroll 事件分不出來源,不做這件事的話我們自己捲的每一下
   * 都會被當成使用者操作記下來,自動捲動就會在第一次之後永遠停擺。
   * 往回撥而不是設旗標,是因為平滑捲動會分很多幀送出事件,
   * 旗標很難決定什麼時候該放下來。
   */
  userScrolledAt = -USER_SCROLL_GRACE_MS;

  bodyEl.scrollTo({
    top: Math.max(0, target),
    behavior: smooth ? 'smooth' : 'auto',
  });
}
