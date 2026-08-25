/**
 * lrc-panel.js
 * Spotify 未提供歌詞時,以 LRCLIB 的歌詞另行浮出一個面板。
 *
 * 必要性:部分歌曲 Spotify 根本不提供歌詞(授權未談成、冷門曲目),
 * 此時整條流程無所依附 —— 沒有歌詞行即沒有拼音。
 * service worker 本就會向 LRCLIB 取得歌詞,先前僅缺少顯示的位置。
 *
 * ── 本面板刻意採取的一項決定 ──────────────────────────────
 * 面板的每一行做成與 Spotify 歌詞行同構的元素:
 *
 *   <li data-romaji-source="原文">
 *     <span class="romaji-original">原文</span>
 *     <span class="romaji-overlay">…逐字 span…</span>
 *   </li>
 *
 * 如此一來,顯示模式的 CSS、手動切分的點擊委派、補讀音面板、
 * 逐字掃描的 paintSweep 皆可原封不動地套用於面板,毋須為面板重寫任何一行。
 * 轉換本身亦交還 index.js 的既有佇列,此處僅負責排列行與標示目前唱到何處。
 *
 * 手動切分同樣共用:其 key 為原始日文歌詞行,因此同一句歌詞在 Spotify
 * 歌詞上切過的空格,於本面板亦直接生效。
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
 * 使用者自行捲動後的暫緩期間。
 *
 * 缺少此段時,無法往回檢視前幾句 —— 每 80ms 的更新會立即將畫面拉回
 * 正在演唱的那一句,操作手感如同被面板甩開。
 */
const USER_SCROLL_GRACE_MS = 4000;

let panelEl = null;
let bodyEl = null;
let lineEls = [];

/** 與 lineEls 一一對應的起始時間;無時間軸(僅有純文字歌詞)時為 null */
let times = null;
/** 與 lineEls 一一對應的逐字進度折線,無逐字資料的行為 null */
let curves = [];

let lastActive = -1;
let userScrolledAt = 0;
let onCloseCallback = null;

/* -------------------------------------------------------------- 拖曳 */

/*
 * 可拖曳的必要性:面板固定於右上角,而 Chrome 的擴充功能設定視窗必然亦位於右上角
 * (由瀏覽器決定,無法變更)。兩者必定重疊,使用者一開啟設定即看不到歌詞。
 *
 * 不採「自動置於 Spotify 中央區塊」的理由:該作法須推測其版面結構,
 * 而本擴充功能已因 Spotify 改版損壞過一次。由使用者自行擺放則不依賴任何選擇器,
 * 對方改版數次亦不會失效。
 */

const POSITION_KEY = 'lrcPanelPos';

let dragging = null;

function enableDrag(panel, handle, closeButton) {
  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || closeButton.contains(event.target)) return;
    event.preventDefault(); // 避免瀏覽器將標題文字選取起來

    const rect = panel.getBoundingClientRect();
    /*
     * 面板原以 top/right/bottom 撐出高度。改用 left/top 定位之前必須先固定高度,
     * 否則 bottom 一經解除,面板會縮至僅剩標題列的高度。
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
 * 記錄位置與大小。
 *
 * 寫入失敗亦無妨 —— 至多是下次回到預設位置,不值得打擾使用者。
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
   * 節流。拉伸時 ResizeObserver 每一幀觸發一次,單次拖曳即產生上百次寫入 ——
   * storage 有寫入頻率上限,一旦灌爆,其他功能的儲存亦會一併失敗
   * (自訂讀音即曾因此損壞)。
   */
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [POSITION_KEY]: layout }).catch(() => {});
  }, 400);
}

/*
 * 掛於 document 而非面板:放開滑鼠時游標常已離開面板(拖曳較快時),
 * 掛於面板將接收不到該事件,面板便會黏在游標上。
 */
document.addEventListener('mousemove', onDragMove);
document.addEventListener('mouseup', onDragEnd);

/** 視窗縮小時將面板拉回可見範圍 */
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
 * 監看面板的尺寸變化。
 *
 * 採 ResizeObserver 而非監聽事件:右下角的拉伸把手為瀏覽器內建,
 * 不會發出任何可攔截的事件 —— 僅能觀察到「大小已變更」這一結果。
 */
let sizeObserver = null;
function watchResize(panel) {
  sizeObserver?.disconnect();
  sizeObserver = new ResizeObserver(() => {
    // 拖曳期間不儲存:該時段位置每一幀皆在變動,待放開後儲存一次即可
    if (!dragging) saveLayout();
  });
  sizeObserver.observe(panel);
}

/** 還原上次拖曳後的位置與大小。未曾儲存則沿用 CSS 的預設值。 */
async function restorePosition(panel) {
  try {
    const stored = await chrome.storage.local.get(POSITION_KEY);
    const saved = stored[POSITION_KEY];
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;

    const rect = panel.getBoundingClientRect();
    // 舊版紀錄不含 width,缺少時沿用目前值,不整筆捨棄
    const width = Number.isFinite(saved.width) ? saved.width : rect.width;
    const height = Number.isFinite(saved.height) ? saved.height : rect.height;

    // 儲存當下的畫面可能大於現在,故還原時須再行夾限
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
    // 讀取失敗即採預設位置,不足以中斷流程
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
   * scroll 事件無法區分使用者捲動與程式捲動,因此自動捲動時會先將
   * userScrolledAt 往回撥(見 scrollToActive),此處收到的便僅剩真正的使用者操作。
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
 * 將一行歌詞建成 <li>。
 *
 * 刻意僅置入純文字而不在此進行轉換 —— 拼音由 index.js 的佇列統一處理
 * (其會以 ensureOriginalWrapper 將文字包入 .romaji-original,
 * 再將拼音填入 .romaji-overlay)。兩種來源共用同一套流程,
 * 即不致出現「Spotify 側已修好、面板側仍為舊行為」的情形。
 */
function buildLine(text) {
  const li = document.createElement('li');
  li.className = LINE_CLASS;
  // 間奏行(僅有時間而無文字)須保留以佔位,否則高亮會停滯於上一句
  li.textContent = text || '';
  return li;
}

/* ------------------------------------------------------------ 對外介面 */

/**
 * 開啟面板。重複呼叫會整個重建(換歌時即為如此)。
 *
 * @param {object} options
 * @param {string} options.title    面板標題(曲名)
 * @param {string} options.subtitle 副標(歌手與來源)
 * @param {Array<{timeMs:number,text:string,words?:Array}>|null} options.timed
 *        有時間軸的歌詞。高亮與逐字掃描僅在具備此項時成立。
 * @param {string[]|null} options.plain
 *        僅有純文字的歌詞。無時間軸時的退路,只顯示而不高亮。
 * @param {() => void} [options.onClose] 使用者按下關閉時的回呼
 * @returns {HTMLElement[]} 已建立的行元素,呼叫端須將其送入轉換佇列
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
  // 位置為非同步讀取,面板會先出現於預設位置再移至記錄的位置。
  // 該次跳動優於「待讀取完成才顯示」:歌詞延遲出現才是使用者真正在意的事
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
  // 面板即將移除,繼續監看只會留下無人管理的觀察者
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

/** 面板上的行元素。index.js 的佇列依此決定先轉換哪一行。 */
export function getPanelLineElements() {
  return lineEls;
}

/**
 * 面板遭頁面重建移除時重新掛回。
 *
 * Spotify 為 React SPA,理論上不會動到 append 於 body 末端的元素,
 * 但其換頁時確有整批清理的動作。每秒確認一次的成本低廉,
 * 而若確實遭移除卻未補回,使用者所見即為面板無故消失。
 */
export function ensurePanelAttached() {
  if (panelEl && !panelEl.isConnected) document.body.appendChild(panelEl);
}

/**
 * 更新目前演唱的行與行內進度。
 *
 * @param {number|null} positionMs 已套用提前量的播放位置
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

/** 此句結束的時間,即下一句開始的時間。最後一句沒有下一句,給予一個合理長度。 */
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
 * 將正在演唱的那一句捲至面板中央偏上的位置。
 *
 * 採偏上而非正中央:跟唱者需要看的是接下來幾句,
 * 已唱過的保留一兩行作為定位參考即已足夠。
 */
function scrollToActive(lineEl) {
  if (!bodyEl || !lineEl) return;

  // 使用者方才自行捲動時暫不介入,待其停手一段時間後再接手
  if (performance.now() - userScrolledAt < USER_SCROLL_GRACE_MS) return;

  const target = lineEl.offsetTop - bodyEl.clientHeight * 0.38;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * 先將「使用者捲動」的時間戳往回撥,再自行捲動。
   *
   * scroll 事件無法區分來源,若不作此處理,程式自身的每一次捲動
   * 皆會被記為使用者操作,自動捲動便會在第一次之後永久停擺。
   * 採往回撥而非設立旗標,是因為平滑捲動會分散於多幀送出事件,
   * 旗標難以決定何時該解除。
   */
  userScrolledAt = -USER_SCROLL_GRACE_MS;

  bodyEl.scrollTo({
    top: Math.max(0, target),
    behavior: smooth ? 'smooth' : 'auto',
  });
}
