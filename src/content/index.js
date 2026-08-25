/**
 * content/index.js
 * Chrome Extension 的 content script,注入 open.spotify.com。
 *
 * 取代原本的 content.js(現置於 legacy/),主要差異:
 * - 轉換改用 kuroshiro,漢字亦會被轉出(原本只用 wanakana,漢字會原樣留著)
 * - kuroshiro 為非同步,故處理流程改為佇列加上提前上鎖,避免重複轉換同一行
 * - MutationObserver 加上 debounce,換歌與關閉面板時會解除再重新掛上
 * - 顯示模式(上 / 下 / 只顯示拼音)交由 CSS 處理,切換設定毋須重新轉換
 */

import { toRomaji, toKana, ready, invalidateRomajiCache } from './romaji.js';
import { findUnromanized, findUnreadKanji, toLetterRanges } from './cjk.js';
import {
  onCorrectionsChanged,
  loadSharedDictionary,
  setCurrentSong,
} from './corrections-store.js';
import {
  openCorrectionPopover,
  closeCorrectionPopover,
  handleOutsideClick,
} from './correction-popover.js';
import { syncToggleButton, renderToggleButton } from './toggle-button.js';
import { markActive } from './active-line.js';
import { centerActiveLine, resetAutoScroll } from './auto-scroll.js';
import { showNotice, hideNotice } from './notice.js';
import { startClock, stopClock, getPositionMs, getDurationMs } from './playback-clock.js';
import { parseLrc } from './lrc.js';
import {
  alignLrc,
  fillGaps,
  activeIndexAt,
  buildWordCurve,
  progressFromCurve,
  progressAt,
  paintSweep,
} from './sync-highlight.js';
import {
  splitRomaji,
  renderRomaji,
  readBoundaries,
  boundaryFromClick,
  toggleBoundary,
  setCaret,
  moveCaret,
  getCaret,
  loadSplits,
  preloadSplits,
  saveSplits,
} from './splitter.js';
import {
  openLrcPanel,
  closeLrcPanel,
  isLrcPanelOpen,
  getPanelLineElements,
  updateLrcPanel,
  ensurePanelAttached,
  seekFromPanelClick,
} from './lrc-panel.js';
import {
  DEFAULTS,
  getSettings,
  setSetting,
  isConversionOff,
  conversionKind,
  normalizeMode,
  normalizeOffset,
  normalizeSweepMs,
  normalizeColor,
  normalizeScale,
  nextMode,
} from '../shared/settings.js';

const LOG = '[romaji]';

// 實測於 Spotify 網頁版(見 README)。
// 容器本身已不再具備專屬的 data-testid(Spotify 改版),
// 故不再以容器選擇器抓取歌詞區塊,直接抓歌詞行、observer 掛在 document.body 上。
const LINE_SELECTOR = '[data-testid="lyrics-line"]';
const LYRICS_BUTTON_SELECTOR = '[data-testid="lyrics-button"]';

const PROCESSED_FLAG = 'data-romaji-processed'; // pending | done | skipped | empty
const DEBOUNCE_MS = 100;
// 連續變動時至多拖延這麼久便一定要掃描一次,避免被高頻變動餓死
const MAX_WAIT_MS = 350;
const TICK_MS = 1000;
// 高亮的更新節奏。逐字掃描要夠細才會流暢,
// 但 paintSweep 在無變化時會直接返回,故頻率高亦不昂貴。
const ACTIVE_TICK_MS = 80;

// 高亮提前量已移至設定中(settings.syncOffsetMs),可於 popup 即時調整。
// 該值沒有放諸四海皆準的答案 —— 音訊緩衝、顯示延遲、個人偏好皆會影響,
// 故與其寫死一個數字反覆推測,不如讓使用者自行對準。

/*
 * 註:此處先前有一組「以字數估算演唱速度」的常數,用以推測句子內部的進度。
 * 已移除 —— 僅有句首時間時,「唱得快」與「唱得慢」的句子在資料上
 * 完全相同,那組估算不論如何調整都只是在兩種誤差之間換邊。
 * 現行作法為:有逐字時間軸即精準掃描,沒有則整句一起亮。
 */
/*
 * 歌詞檢視已開啟、卻連續這麼多秒仍等不到任何一行,才向 LRCLIB 查詢。
 *
 * 這個數字是在兩種代價之間取捨:
 * - 太短 → Spotify 其實只是載得慢,結果搶先開了面板;雖然 Spotify 的歌詞
 *   一出現 tick() 就會收掉面板,但使用者會看到它閃一下,也白問了一次 LRCLIB
 * - 太長 → 真的沒有歌詞的歌,要乾等這麼久才有東西可看
 *
 * 原為 12,實際使用後判斷等待過久,改為 4。
 * 搶先開面板的代價有兩道防護:送出請求後、真正開啟面板之前會再確認一次
 * Spotify 的歌詞是否已經出現(見 tryLrclibFallback),而即使漏掉,
 * tick() 下一秒也會把面板收起來。
 */
const FALLBACK_AFTER_TICKS = 4;

let settings = { ...DEFAULTS };
let observer = null;
let scanTimer = null;
let firstPendingAt = 0; // 這一串連續變動最早自何時開始等待(0 = 未在等待)
let lastScanAt = 0; // 上一次實際掃描的時間
let selfMutating = 0; // >0 代表目前的 DOM 變動由自身造成,observer 須略過
let emptyTicks = 0;
let fallbackAskedFor = null; // 已向 LRCLIB 查詢過的曲目 key,避免重複請求
let currentTrackKey = null; // 目前這首歌,用以偵測換歌
let panelDismissedFor = null; // 使用者手動關閉面板的曲目 key,同一首不再自動開啟

/* ---------------------------------------------------------------- 設定 */

/** displayMode 為 'off' 時完全不做轉換,亦不插入任何羅馬拼音元素 */
function isEnabled() {
  return !isConversionOff(settings.displayMode);
}

function applySettings() {
  const root = document.documentElement;
  root.setAttribute('data-romaji-mode', settings.displayMode);

  /*
   * 外觀走 CSS 變數,而非直接修改每個元素的樣式。
   *
   * 兩項好處:變更設定時只動一處(毋須走訪數十行歌詞),且
   * 毋須重新轉換 —— 顏色與大小純屬顯示,與拼音的內容無關。
   *
   * 值一定要先經過 normalize:該份設定是跨裝置同步的,不限於本機,
   * 直接把儲存中的字串塞進樣式等同於讓外部資料影響頁面。
   */
  root.style.setProperty('--romaji-color', normalizeColor(settings.romajiColor));
  root.style.setProperty('--romaji-scale', String(normalizeScale(settings.romajiScale)));
}

/**
 * 頁面上那顆按鈕的點擊處理。
 * 僅負責寫入 storage —— 按鈕外觀交由下方的 onChanged 統一更新,
 * 如此頁面按鈕與 popup 單選鈕永遠反映同一份已儲存的狀態,不會各行其是。
 */
async function cycleDisplayMode() {
  try {
    await setSetting('displayMode', nextMode(settings.displayMode));
  } catch (err) {
    console.warn(`${LOG} 寫入設定失敗:`, err);
  }
}

// popup 或頁面按鈕任一端變更了設定,此處皆會收到
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  // 提前量是即時生效的:下一次 updateActiveLine 便會採用新值,
  // 故使用者拖曳滑桿時可一邊聆聽一邊對準,毋須重新整理
  if (changes.syncOffsetMs) {
    settings.syncOffsetMs = normalizeOffset(changes.syncOffsetMs.newValue);
  }
  if (changes.sweepMsPerLetter) {
    settings.sweepMsPerLetter = normalizeSweepMs(changes.sweepMsPerLetter.newValue);
  }

  // 外觀屬純顯示,套用 CSS 變數即可 —— 毋須重新轉換,故拖曳色盤是即時的
  if (changes.romajiColor || changes.romajiScale) {
    if (changes.romajiColor) settings.romajiColor = normalizeColor(changes.romajiColor.newValue);
    if (changes.romajiScale) settings.romajiScale = normalizeScale(changes.romajiScale.newValue);
    applySettings();
  }

  if (!changes.displayMode) return;

  const before = conversionKind(settings.displayMode);
  settings.displayMode = normalizeMode(changes.displayMode.newValue);
  applySettings();
  renderToggleButton(settings.displayMode);

  /*
   * 拼音與平假名之間須重新轉換,拼音的兩種顯示方式之間則毋須。
   *
   * romaji-only 與 both 的差別純粹在 CSS,已轉換完成的內容照用即可。
   * 但平假名需要的是另一份文字,不重轉的話畫面會停留在舊的那一種 ——
   * 且因旗標仍為 'done',它永遠不會自行更新。
   *
   * 反過來說亦不可無條件重轉:整批重跑斷詞會使頁面卡住數秒,
   * 僅為更換顯示方式並不值得。
   */
  if (conversionKind(settings.displayMode) !== before) reconvertEverything();

  // 由「關閉」切回其他模式時,期間出現的歌詞行皆尚未轉換,補掃一次
  if (isEnabled()) scanSoon();
});

/**
 * 將所有已處理的行打回未處理,重新走一次轉換。
 *
 * 兩件事缺一不可:移除處理旗標、重新掃描。缺少旗標那一步,
 * needsProcessing 會判定「這一行已處理過」而不重轉。
 *
 * 注意此處不清除 romaji.js 的轉換快取,那是呼叫端的責任:
 * 更換轉換種類毋須清除(快取的 key 帶有種類,兩種答案本就分開存放),
 * 但變更了自訂讀音就一定要清除,否則取回的仍是舊讀音。
 */
function reconvertEverything() {
  for (const el of document.querySelectorAll(`[${PROCESSED_FLAG}]`)) {
    el.removeAttribute(PROCESSED_FLAG);
    delete el.dataset.romajiSource;
  }
  runScan();
}

/* ------------------------------------------------------------ 單行處理 */

/**
 * 將原本的內容包入 .romaji-original,使 CSS 得以獨立控制原文與拼音的順序與顯示。
 * 採搬移子節點而非覆寫 innerHTML,避免破壞 Spotify 自身的內層結構。
 */
function ensureOriginalWrapper(lineEl) {
  let original = lineEl.querySelector(':scope > .romaji-original');
  if (!original) {
    original = document.createElement('span');
    original.className = 'romaji-original';
    // 搬移的是 React 自己的子節點,產生的變動記錄自外部看來與真正的內容變動
    // 無從分辨,故先舉旗告知 observer「這一段是自身所為」
    selfMutating += 1;
    try {
      while (lineEl.firstChild) original.appendChild(lineEl.firstChild);
      lineEl.appendChild(original);
    } finally {
      // observer callback 於 microtask 執行,須待其看完這一批才降旗
      queueMicrotask(() => {
        selfMutating -= 1;
      });
    }
  }
  return original;
}

/**
 * 確保這一行有拼音容器,並回傳之。
 *
 * 刻意在「送去轉換之前」即建立,且為空的 —— CSS 會為空的 overlay
 * 預留一行高度,如此拼音填入時整行不會突然撐開而造成畫面跳動。
 */
function ensureOverlay(lineEl) {
  let overlay = lineEl.querySelector(':scope > .romaji-overlay');
  if (!overlay) {
    overlay = document.createElement('span');
    overlay.className = 'romaji-overlay';
    lineEl.appendChild(overlay);
  }
  return overlay;
}

/**
 * 確實有拼音之後才使其可被 Tab 選取。
 * 空的容器即開放焦點的話,Tab 順序會多出一堆按了沒有反應的停留點。
 */
function makeOverlayInteractive(overlay) {
  if (overlay.tabIndex === 0) return;
  overlay.tabIndex = 0;
  overlay.setAttribute('role', 'textbox');
  overlay.setAttribute('aria-label', '羅馬拼音,可點擊或用左右鍵移動游標、空白鍵切分、Enter 完成');
}

/**
 * 走訪節點,同時取出「原文」與「將振假名替換上去之後的文字」。
 *
 * Spotify 部分歌詞帶有振假名,結構為 <ruby>藻掻<rt>もが</rt></ruby>いて。
 * 直接讀取 textContent 會將注音一併串入而成為「藻掻もがいて」——
 * 那是一段根本不存在的文字,kuromoji 自然轉不正確。
 *
 * 但反過來看,那個 <rt> 即是權威讀音,遠比 kuromoji 推測的可靠。
 * 故此處一次取兩份:
 *   plain   供畫面顯示、作為儲存的 key、供 popover 顯示(乾淨的原文)
 *   reading 將漢字替換為振假名之後的文字,用於轉換
 * 等同於每一行都自帶一份正確的讀音表。
 */
function extractRuby(root) {
  let plain = '';
  let reading = '';

  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      plain += node.nodeValue;
      reading += node.nodeValue;
      continue;
    }
    if (node.nodeType !== 1) continue;

    const tag = node.tagName.toLowerCase();
    if (tag === 'rt' || tag === 'rp') continue; // 注音本身不計入原文

    if (tag === 'ruby') {
      const inner = extractRuby(node); // 已排除 rt/rp,取得的是其下的漢字
      const rt = node.querySelector('rt');
      plain += inner.plain;
      reading += rt ? rt.textContent : inner.reading;
      continue;
    }

    const inner = extractRuby(node);
    plain += inner.plain;
    reading += inner.reading;
  }

  return { plain, reading };
}

/**
 * 這一行的原文,以及要送去轉換的文字。
 *
 * 一定要走 .romaji-original,不可使用 lineEl.textContent —— 包裹之後
 * 後者是「原文加拼音」黏在一起,拿去與 romajiSource 比對永遠不會相等,
 * 將導致每一行無限重轉。
 */
function readLineParts(lineEl) {
  const scope = lineEl.querySelector(':scope > .romaji-original') ?? lineEl;

  // 絕大多數歌詞沒有振假名,這條快速路徑省下每次掃描都走訪整棵樹
  if (!scope.querySelector('rt')) {
    const text = scope.textContent.trim();
    return { text, forConversion: text };
  }

  const { plain, reading } = extractRuby(scope);
  return { text: plain.trim(), forConversion: reading.trim() };
}

function readLineText(lineEl) {
  return readLineParts(lineEl).text;
}

/** 這一行仍是當初開始處理的那一行、那段文字嗎? */
function isCurrent(lineEl, text) {
  return lineEl.isConnected && lineEl.dataset.romajiSource === text;
}

/**
 * 判斷這一行是否需要(重新)處理。
 *
 * Spotify 是 React SPA,且歌詞為虛擬列表 —— 元素會被回收重用,
 * 將新的一句寫入舊的元素中。故「有無旗標」完全不足以判斷,
 * 每一種狀態都必須先比對文字是否變更。
 *
 * 順序至關重要:文字比對須排在 pending 短路之前,
 * 否則正在轉換中被回收的元素會卡在舊句子上不再更新。
 */
function needsProcessing(lineEl) {
  const state = lineEl.getAttribute(PROCESSED_FLAG);
  if (!state) return true;

  // 文字更換即一律重來,不論先前為何種狀態
  if (lineEl.dataset.romajiSource !== readLineText(lineEl)) return true;

  if (state === 'pending') return false; // 同一段文字正在處理中
  if (state === 'done') return !lineEl.querySelector(':scope > .romaji-overlay');
  return false; // 'skipped'(純英文)與 'empty'(空行)對這段文字即為終點
}

async function processLyricsLine(lineEl) {
  ensureOriginalWrapper(lineEl);

  // text 是乾淨的原文(作為 key、供 popover 使用);
  // forConversion 是將振假名替換上去之後的文字,僅用於轉換
  const { text, forConversion } = readLineParts(lineEl);

  // 空行(間奏)。須標記為 'empty' 而非移除旗標 ——
  // 移除的話 needsProcessing 會永遠回傳 true,每次掃描都白排一次隊。
  // romajiSource 設為空字串,待確實有文字進來時比對即不相等而重新處理。
  if (!text) {
    lineEl.dataset.romajiSource = '';
    lineEl.setAttribute(PROCESSED_FLAG, 'empty');
    return;
  }

  // 在任何 await 之前先上鎖 —— MutationObserver 會連續觸發,
  // 缺少這一行,同一句歌詞會被送去轉換數次。
  lineEl.dataset.romajiSource = text;
  lineEl.setAttribute(PROCESSED_FLAG, 'pending');

  // 在 await 之前即建立 overlay。它此時是空的,但 CSS 已為其
  // 預留一行的高度 —— 如此稍後拼音填入時整行不會突然撐開。
  const overlay = ensureOverlay(lineEl);

  // settled = 已抵達某個終點狀態(done / skipped)。
  // 未抵達即代表中途放棄,finally 須負責解鎖,否則這一行會永久卡在
  // 'pending',而 needsProcessing 對 pending 回傳 false —— 永遠不會再有拼音。
  const kind = conversionKind(settings.displayMode);

  let settled = false;
  try {
    const converted = kind === 'kana' ? await toKana(forConversion) : await toRomaji(forConversion);

    // 等待期間 Spotify 可能已將這個元素替換或修改其內容
    if (!isCurrent(lineEl, text)) return;

    if (!converted) {
      lineEl.setAttribute(PROCESSED_FLAG, 'skipped'); // 純英文行等等
      settled = true;
      return;
    }

    // kuroshiro 給出的空格僅為預設值;使用者手動切過的話以其為準
    const { letters, boundaries: fromKuroshiro } = splitRomaji(converted);

    /*
     * 手動切分僅在羅馬拼音模式下有效。
     *
     * 並非省略未做,而是共用同一份儲存會相互破壞:切點存的是字母索引,
     * 而同一句話的假名字數與拼音字母數完全不同。拿假名的切點去套用於拼音
     * (或反之)只會把空格插在錯誤的位置,且因 letters 校驗碼對不上,
     * 使用者原本存好的拼音切分還會被整批判定過期。
     *
     * 且假名模式本就不太需要切分 —— 那是為了拆開長串拉丁字母才有的功能。
     */
    const canSplit = kind === 'romaji';
    const saved = canSplit ? await loadSplits(text, letters) : null;

    if (!isCurrent(lineEl, text)) return;

    /*
     * 標示出哪幾個字未轉出(kuromoji 不認識的詞會原樣輸出漢字)。
     * 位置須自「字串位置」換算為「字母索引」,因為空白已被移除。
     *
     * 兩種模式所要尋找的並不相同:拼音模式下任何殘留的日文皆屬失敗,
     * 但假名模式的輸出本就整片是假名,只有漢字才代表未讀出。
     */
    const leftover = kind === 'kana' ? findUnreadKanji(converted) : findUnromanized(converted);
    const unknown = toLetterRanges(converted, leftover);

    if (canSplit) makeOverlayInteractive(overlay);
    renderRomaji(overlay, letters, saved ?? fromKuroshiro, null, unknown);
    lineEl.setAttribute(PROCESSED_FLAG, 'done');
    settled = true;
  } finally {
    // 僅在「這一行仍是自身所鎖的那一行」時才解鎖。
    // 兩個附加條件缺一不可 —— 若中途放棄正是因為文字被替換,
    // 那時新的一輪處理已重新上鎖,不可將它的 pending 洗掉。
    if (
      !settled &&
      lineEl.getAttribute(PROCESSED_FLAG) === 'pending' &&
      lineEl.dataset.romajiSource === text
    ) {
      lineEl.removeAttribute(PROCESSED_FLAG);
    }
  }
}

/* ------------------------------------------------------- 手動切分拼音 */

/*
 * 切字只有一個動作:空白鍵。
 *
 * 滑鼠負責定位與選取:點擊將游標置於該位置(不切字)、拖曳選取文字、
 * 雙擊開啟修正面板。左右鍵移動游標,Enter 與 Esc 離開。
 *
 * ── 移除「點擊即切分」的原因 ────────────────────────────────
 * 該設計使滑鼠無法從事其他操作:想選取一段拼音檢視、想雙擊編輯,
 * 每一下都會順手切一刀,且要退回還須再點一次同一個位置。
 * 一個會變更資料的動作不應綁在最容易誤觸的操作上。
 *
 * 切點的位置系統(splitter.js 的 boundary)與切換動作(toggleBoundary)
 * 仍然只有一份,滑鼠定位與鍵盤切換共用,不各寫一套。
 */

/** 目前正在鍵盤編輯的那一行,null 代表沒有 */
let editingOverlay = null;

/**
 * 滑鼠按下時焦點會落在 overlay 上,connectFocus 須分辨
 * 「此次 focus 由滑鼠造成」或「使用者按 Tab 切換而來」。
 */
let pointerActive = false;

/*
 * 此處曾有一個 lastToggle,用於在雙擊時撤回「第一下點擊所插入的切點」。
 * 滑鼠不再切字之後即不需要 —— 沒有東西要撤回,也就沒有撤回位置猜錯的風險。
 */

/** 將目前畫面上的切分寫回 storage */
async function persistSplits(overlay) {
  const source = overlay.parentElement?.dataset?.romajiSource;
  if (!source) return;
  const letters = overlay.dataset.romajiLetters ?? '';
  await saveSplits(source, letters, readBoundaries(overlay));
}

function enterEditMode(overlay, caret) {
  if (editingOverlay && editingOverlay !== overlay) exitEditMode();

  editingOverlay = overlay;
  overlay.classList.add('is-editing');
  setCaret(overlay, caret ?? 1);
}

/** 離開編輯模式並存檔(對應需求:Enter / Esc 存入 chrome.storage.local) */
async function exitEditMode() {
  const overlay = editingOverlay;
  if (!overlay) return;

  // 先清除狀態,如此下方 blur() 觸發的 focusout 不會再執行一次
  editingOverlay = null;
  overlay.classList.remove('is-editing');
  setCaret(overlay, null); // 收起游標
  overlay.blur?.();

  await persistSplits(overlay);
}

async function onRomajiClick(event) {
  // 點擊修正面板之外即將其關閉。以既有的事件委派處理,不另掛 listener。
  if (handleOutsideClick(event.target)) return;

  const overlay = event.target?.closest?.('.romaji-overlay');

  /*
   * 點到「未轉出的字」→ 開啟修正面板,而非插入空格。
   *
   * 條件中的「不在編輯模式」不可移除:進入鍵盤編輯模式之後,
   * 滑鼠僅負責移動游標,此時彈出面板會打斷正在進行的切分操作。
   * 且在轉不出來的漢字中插入空格本就沒有意義,故不損失任何功能。
   */
  const unknownChar = event.target?.closest?.('.romaji-ch[data-romaji-unknown]');
  if (unknownChar && editingOverlay !== overlay) {
    event.preventDefault();
    event.stopPropagation();
    openCorrectionPopover({
      lineText: overlay.parentElement?.dataset?.romajiSource ?? '',
      surface: unknownChar.dataset.romajiSurface ?? '',
      anchor: unknownChar.getBoundingClientRect(),
      guardKeydown: guardEditKey,
      songTitle: readNowPlaying()?.trackName ?? '',
    });
    return;
  }

  /*
   * LRCLIB 面板:點一句即跳至該句的播放位置。
   *
   * 位置在此有兩個理由。排在補讀音之後 —— 紅色底線的字是明確標記過的
   * 目標,點它是要補讀音,跳走屬於誤觸。排在放游標之前 —— 面板上
   * 「重聽這一句」遠比手動切分常用,而兩者搶的是同一個動作;
   * 切分仍可經由 Tab 聚焦進入編輯模式(onRomajiFocusIn 已支援)。
   *
   * 這一段必須位於下方的 overlay 檢查之前:點在行的留白處(不在拼音上)
   * 同樣要跳,而那時 overlay 為 null。
   */
  if (seekFromPanelClick(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (!overlay) return;

  /*
   * 平假名模式不接受手動切分 —— 理由見 processLyricsLine 中的說明
   * (切點是字母索引,假名與拼音的字數不同,共用同一份儲存會相互破壞)。
   *
   * 這道防線不可省略:上方 makeOverlayInteractive 未被呼叫僅代表不給鍵盤焦點,
   * 擋不住滑鼠點擊。缺少這一行,在假名模式點擊即會將假名的切點
   * 寫入拼音的那一筆記錄中。
   *
   * 補讀音的面板則予以保留 —— 該判斷排在前方,假名模式同樣看得到
   * 讀不出來的漢字,也同樣應讓使用者當場補上。
   */
  if (conversionKind(settings.displayMode) !== 'romaji') return;

  const letters = overlay.dataset.romajiLetters ?? '';
  const boundary = boundaryFromClick(event, letters.length);
  if (boundary === null) return;

  /*
   * 攔下,不使 Spotify 誤以為使用者要跳轉播放位置。
   *
   * 這一行不影響選取 —— 選取於 mousedown 與 mousemove 時即已完成,
   * 至 click 時早已定案,preventDefault 所攔的是「跳轉播放」那個動作。
   */
  event.preventDefault();
  event.stopPropagation();

  /*
   * 點擊只放置游標,不切字。
   *
   * 先前是點到何處即在該處插入空格。該設計的問題在於使用者無法以滑鼠進行
   * 任何其他操作:想選取一段拼音檢視、想雙擊編輯,每一下都會順手切一刀,
   * 且要退回還須再點一次同一個位置。
   *
   * 現行作法使滑鼠回歸其本來的角色(選取、定位),切字一律交由空白鍵 ——
   * 那是一個明確且不易誤觸的動作。游標仍須放置,否則空白鍵不知該切在何處。
   */
  enterEditMode(overlay, boundary);
}

/**
 * 雙擊拼音 → 開啟修正面板,自行修改讀音。
 *
 * ── 修改「讀音」而非直接修改拼音字母的原因 ────────────────────
 * 直覺上「拼音錯了就讓他改拼音」最為單純,但如此改出的內容只對這一句有效:
 * 換一首歌、甚至同一首歌的翻唱版(斷句不同)即對不上,又要再改一次。
 *
 * 拼音是由讀音推導而來。修改讀音等同於改在源頭 —— 存的是「這個詞唸什麼」,
 * 之後任何歌曲出現同一個詞都會是正確的,且能直接分享給其他使用者。
 * 故雙擊開啟的是同一個修正面板,只是更換一個標題。
 *
 * ── 與切分功能的關係 ──────────────────────────────────────
 * 面板開啟時,點擊拼音只會將面板關閉(onRomajiClick 開頭的 handleOutsideClick),
 * 不會動到切分。而滑鼠本身已不再切字,故雙擊毋須再收拾任何東西。
 */
async function onRomajiDblClick(event) {
  const lineEl = event.target?.closest?.('[data-romaji-source]');
  const overlay = lineEl?.querySelector(':scope > .romaji-overlay');
  if (!lineEl || !overlay) return;

  // 攔下,否則 Spotify 亦可能收到這一下
  event.preventDefault();
  event.stopPropagation();

  // 鍵盤編輯模式與修正面板不並存 —— 兩者都要接收方向鍵與 Enter
  await exitEditMode();

  openCorrectionPopover({
    lineText: lineEl.dataset.romajiSource ?? '',
    surface: surfaceFromSelection(lineEl),
    anchor: (event.target.closest?.('.romaji-ch') ?? event.target).getBoundingClientRect(),
    guardKeydown: guardEditKey,
    title: '修正讀音',
    songTitle: readNowPlaying()?.trackName ?? '',
  });

  // 用畢即棄。保留的話,下一次於同一行雙擊會端出一段早已不相干的舊選取
  lastOriginalSelection = null;
}

/**
 * 使用者最後一次選取的原文。
 *
 * ── 須另行記錄而不能等雙擊時再讀取的原因 ────────────────────
 * 因為屆時已經沒有了。滑鼠選好一段之後再雙擊,事件順序為
 * mousedown → mouseup(選取於此被收起,成為一個游標點)→ mousedown → dblclick,
 * 待 dblclick 派送過來時,選取只剩下「瀏覽器為第二下自動選取的那個詞」,
 * 使用者辛苦拉出的範圍早已不存在。
 *
 * 故於捕獲階段的 mousedown 即先行記錄 —— 那一刻仍早於瀏覽器動手。
 * 僅在記錄得到內容時才覆寫:雙擊的第二下讀到的是空的,
 * 讓它覆寫等同於自行抹去剛記錄好的內容。
 */
let lastOriginalSelection = null;

/**
 * 目前選取的是哪一行原文的哪一段?非原文即回傳 null。
 *
 * 僅認可原文的選取,不認拼音的:修正所儲存的是「原文的這個詞唸什麼」,
 * 而拼音那一側反推不回去 —— 轉換並未留下「這幾個字母來自原文哪幾個字」
 * 的對應關係,只能按比例估算,估錯的預選比沒有預選更糟。
 *
 * 亦必須能定位至某一行:跨行的選取拼不出一個詞,且面板是拿這段文字
 * 去該行原文中尋找位置的,帶著其他行的字進去只會找不到。
 */
function selectedOriginalText() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const node = selection.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const lineEl = el?.closest?.('.romaji-original')?.closest?.('[data-romaji-source]');
  if (!lineEl) return null;

  const text = selection.toString().trim();
  // 選取的內容必須確實出現在這一行的原文中,否則面板會找不到位置
  if (!text || !(lineEl.dataset.romajiSource ?? '').includes(text)) return null;

  return { lineEl, text };
}

/** 捕獲階段的 mousedown:趕在瀏覽器收起選取之前先行記錄 */
function rememberSelection() {
  const found = selectedOriginalText();
  if (found) lastOriginalSelection = found;
}

/**
 * 雙擊時應預選哪一段原文。
 *
 * 先看目前選取的內容 —— 直接雙擊日文時,瀏覽器會為使用者選取那個詞,
 * 那正好即是他要修改的對象。沒有的話才採用先前記錄的拖曳選取。
 *
 * 兩者皆要求屬於同一行,都對不上則回傳空字串,面板會請使用者自行於其上拉出範圍。
 */
function surfaceFromSelection(lineEl) {
  const live = selectedOriginalText();
  if (live?.lineEl === lineEl) return live.text;
  if (lastOriginalSelection?.lineEl === lineEl) return lastOriginalSelection.text;
  return '';
}

/** Tab 切換而來亦須進入編輯模式(滑鼠造成的 focus 交由 click 處理,避免重複) */
function onRomajiFocusIn(event) {
  if (pointerActive) return;
  const overlay = event.target?.closest?.('.romaji-overlay');
  if (overlay) enterEditMode(overlay);
}

function onRomajiFocusOut(event) {
  const overlay = event.target?.closest?.('.romaji-overlay');
  if (overlay && overlay === editingOverlay) exitEditMode();
}

/**
 * 這一輪按鍵中已於 keydown 被本擴充功能攔下的按鍵代碼。
 *
 * 須記錄的原因:Spotify 的播放與暫停快捷鍵綁在空白鍵的 keyup,
 * 而非 keydown,故僅攔截 keydown 完全無效,仍會播放或暫停。
 * 此處記下「方才於編輯模式攔下的那一顆鍵」,再將其後續的
 * keypress 與 keyup 一併攔下,精準至單一按鍵,
 * 未在編輯模式時這個集合永遠是空的,整個頁面的快捷鍵完全不受影響。
 */
const consumedKeys = new Set();

/** 以 code 而非 key 作為識別,keyup 時的 key 值在某些輸入法下會改變 */
function keyId(event) {
  return event.code || event.key;
}

/**
 * 使修正面板的輸入框重用同一套按鍵防護。
 *
 * 不讓面板自行實作一套的原因:Spotify 的播放與暫停綁在空白鍵的 keyup,
 * 僅攔截 keydown 沒有用。這個細節已在編輯模式踩過一次坑
 * (見 consumedKeys 的說明),不應再實作第二份會走樣的版本。
 */
function guardEditKey(event) {
  consumedKeys.add(keyId(event));
}

/** 編輯模式下由本擴充功能自行處理、不讓 Spotify 看到的按鍵 */
const EDIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Enter', 'Escape']);

/*
 * 注意本函式並非 async,這是刻意的。
 *
 * 事件派送是同步的:函式中一旦出現 await,其餘程式碼便要等到
 * 之後的 microtask 才執行,那時瀏覽器早已派送完這個事件 ——
 * 再呼叫 preventDefault() 或 stopPropagation() 完全沒有作用,
 * consumedKeys 亦加得太晚,擋不住後續的 keyup。
 *
 * (這正是空白鍵仍會觸發 Spotify 播放與暫停的原因:
 *  空白鍵那條路徑上有 await persistSplits,方向鍵沒有,故只有方向鍵正常。)
 *
 * 因此:攔截動作全部同步完成,存檔一類的非同步工作再放出去執行。
 */
function onRomajiKeydown(event) {
  const overlay = editingOverlay;
  if (!overlay) return;
  if (!EDIT_KEYS.has(event.key)) return; // 其他按鍵不攔,交由 Spotify 自行處理

  // ---- 以下三行必須位於任何 await 之前 ----
  // 方向鍵會捲動頁面;空白鍵的播放與暫停綁在 keyup,
  // 靠 consumedKeys 讓 onRomajiKeyEcho 將後續的 keypress 與 keyup 一併攔下。
  consumedKeys.add(keyId(event));
  event.preventDefault();
  event.stopPropagation();

  const caret = getCaret(overlay);

  switch (event.key) {
    case 'ArrowLeft':
      moveCaret(overlay, -1); // 方向鍵允許長按連續移動
      break;
    case 'ArrowRight':
      moveCaret(overlay, 1);
      break;
    case ' ':
    case 'Spacebar': // 舊版 Edge 與 Firefox 的鍵名
      // 按住不放時不連續切換,只認第一次
      if (!event.repeat && caret !== null) {
        toggleBoundary(overlay, caret);
        persistSplits(overlay).catch((err) => console.warn(`${LOG} 儲存切分失敗:`, err));
      }
      break;
    case 'Enter':
    case 'Escape':
      exitEditMode().catch((err) => console.warn(`${LOG} 離開編輯模式失敗:`, err));
      break;
  }
}

/**
 * 攔下「方才於編輯模式攔下的那一顆鍵」後續的 keypress 與 keyup。
 *
 * 這是空白鍵不再觸發播放與暫停的關鍵:Spotify 是在 keyup 才動作的。
 * 判斷條件只看 consumedKeys —— 未進入編輯模式即不會有內容被加入,
 * 故編輯模式關閉時空白鍵完全恢復正常,不會整個頁面被攔下。
 */
function onRomajiKeyEcho(event) {
  const id = keyId(event);
  if (!consumedKeys.has(id)) return;

  // keydown → keypress → keyup,收到 keyup 才算這顆鍵處理完畢
  if (event.type === 'keyup') consumedKeys.delete(id);

  event.preventDefault();
  event.stopPropagation();
}

function registerSplitInteractions() {
  // 全部以捕獲階段委派於 document 上:
  // Spotify 會不斷重建歌詞行,掛在個別元素上的 listener 會隨之被丟棄;
  // 且唯有捕獲階段才能搶在 Spotify 自身的點擊與快捷鍵處理之前。
  document.addEventListener(
    'mousedown',
    () => {
      pointerActive = true;
      // 這一下之後瀏覽器即會收起選取,要記錄趁現在(見 lastOriginalSelection)
      rememberSelection();
    },
    true
  );
  document.addEventListener('mouseup', () => { pointerActive = false; }, true);
  document.addEventListener('click', onRomajiClick, true);
  document.addEventListener('dblclick', onRomajiDblClick, true);
  document.addEventListener('focusin', onRomajiFocusIn, true);
  document.addEventListener('focusout', onRomajiFocusOut, true);
  document.addEventListener('keydown', onRomajiKeydown, true);
  document.addEventListener('keypress', onRomajiKeyEcho, true);
  document.addEventListener('keyup', onRomajiKeyEcho, true);

  // 按住按鍵切換至其他視窗時會收不到 keyup,那顆鍵會卡在集合中。
  // 回來時清除,避免下一次按下它被莫名攔下一次。
  window.addEventListener('blur', () => consumedKeys.clear());
}

/* ---------------------------------------------------------------- 佇列 */

/*
 * kuromoji 的斷詞是同步的 CPU 工作,一次丟入 40 行會使頁面卡住,
 * 故仍逐行處理,每行之間讓出主執行緒。
 *
 * 但「順序」至關重要:依 DOM 順序處理的話,正在演唱的那一行要排在其上方
 * 所有已演唱過的行之後 —— 那正是使用者所見的「拼音慢半拍」。
 * 故改用 Set 搭配每次挑出最該處理的那一行,而非先進先出的佇列。
 */
const pendingLines = new Set();
let draining = false;
let preloadNeeded = false;

function enqueue(lineEl) {
  if (pendingLines.has(lineEl)) return;
  pendingLines.add(lineEl);
  preloadNeeded = true;
  if (!draining) drain();
}

/** 讓出主執行緒。setTimeout(0) 實際上有約 4ms 的下限,40 行即白白多花 160ms */
function yieldToMain() {
  if (typeof scheduler !== 'undefined' && scheduler.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * 挑出下一個最該處理的行。
 *
 * 每一輪都重新檢視「目前唱到何處」,故播放推進時佇列會自動改變目標 ——
 * 這才是「正在播放的那一行不必排隊」真正生效之處。
 */
function pickNext() {
  const lines = currentLineElements();
  const active = lines.findIndex((el) => el.dataset.romajiActive === 'true');

  let best = null;
  let bestScore = Infinity;

  for (const el of pendingLines) {
    const index = lines.indexOf(el);
    let score;
    if (index < 0) score = 1e6; // 已不在任何列表中(元素被回收)排最後
    else if (active < 0) score = index; // 判斷不出正在唱哪一行即依原順序
    else if (index >= active) score = index - active; // 接下來要唱的,越近越優先
    else score = active - index + 1000; // 已演唱過的置於最後

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

async function drain() {
  draining = true;
  try {
    while (pendingLines.size) {
      // 一次將整批的切分設定查詢完畢,而非每行各發一次 IPC。
      // 僅在有新行加入時才執行,否則這個 while 每一輪都會白跑一次。
      if (preloadNeeded) {
        preloadNeeded = false;
        await preloadSplits([...pendingLines].map(readLineText));
      }

      const lineEl = pickNext();
      pendingLines.delete(lineEl);
      if (!lineEl?.isConnected) continue;

      try {
        await processLyricsLine(lineEl);
      } catch (err) {
        console.warn(`${LOG} 處理歌詞行時發生錯誤:`, err);
      }
      await yieldToMain();
    }
  } finally {
    draining = false;
  }
}

/* ------------------------------------------------- LRC 時間軸驅動的高亮 */

/*
 * 兩種驅動方式,能用較佳者即用較佳者:
 *
 * A. LRC 時間軸(理想):已知每一句自第幾毫秒開始,配上播放進度即可算出
 *    「目前第幾句」以及「這一句唱到幾成」。延遲趨近於零,且做得出逐字掃描。
 * B. 觀察 Spotify 畫面(退路):僅知道目前是第幾句,且須待它更新完才得知,
 *    先天慢半拍。沒有 LRC、或 LRC 對不上這個版本時才採用。
 */

/** 與畫面上每一行一一對應的起始時間(毫秒);null 代表目前沒有可用的時間軸 */
let lineTimes = null;

/**
 * 更換時間軸一律經由此處,不要直接指派。
 *
 * 因為「目前有無可用的時間軸」這件事 CSS 也需要知道:有的時候要將
 * Spotify 自身那個遲到的高亮覆蓋掉,由本擴充功能統一標記(見 overlay.css);
 * 沒有的時候絕對不可覆蓋 —— 那時它是唯一的訊號。
 * 兩處各自維護狀態遲早會分岔,故綁在同一支函式中。
 */
function setLineTimes(next) {
  lineTimes = next;
  document.documentElement.toggleAttribute('data-romaji-synced', Boolean(next));
}
/** 與畫面上每一行一一對應的逐字進度折線;無逐字資料的行為 null */
let lineCurves = [];
/** 對齊時所用的行數,行數變更即須重新對齊 */
let alignedCount = 0;
/** 已向 LRCLIB 查詢過的曲目,避免重複請求 */
let lrcAskedFor = null;
/** 這首歌的 LRC 原始內容(尚未對齊之前暫存於此) */
let pendingLrc = null;


function resetLrcState() {
  setLineTimes(null);
  lineCurves = [];
  alignedCount = 0;
  pendingLrc = null;
  // 換歌時歌詞容器會被替換,自動置中所記錄的舊容器與舊行都要一併丟棄
  resetAutoScroll();
  // 上一首的提示留到下一首會成為假訊息
  hideNotice();
}

/**
 * 告知使用者這首歌不會逐字亮起。
 *
 * 須說明的原因:那是正常的(資料本就沒有),但畫面上看起來與損壞無異,
 * 且「延遲校正」滑桿在這類歌曲上如何拖曳都沒有反應 ——
 * 不說明的話,使用者的結論會是「這個擴充功能時好時壞」。
 *
 * 關閉轉換時不說明:那時畫面上根本沒有拼音,說明只會令人費解。
 */
function noticeNoTimeline(title, body) {
  if (!isEnabled()) return;
  showNotice(title, body);
}

/** 此句結束的時間,即下一句開始的時間。最後一句沒有下一句,給予一個合理長度。 */
function nextTimeAfter(index) {
  for (let i = index + 1; i < lineTimes.length; i += 1) {
    if (lineTimes[i] !== null) return lineTimes[i];
  }
  return lineTimes[index] + 4000;
}

/**
 * 向 service worker 索取這首歌的歌詞,兩條路徑共用本函式。
 *
 * 必須共用的原因:曲目長度會影響 service worker 挑選哪個版本
 * (同一首歌常有單曲版、專輯版、Live,長度差異大,時間軸完全不通用),
 * 而兩端的快取又是同一格。此處先前是兩處各自組裝訊息,
 * 只有 requestLrc 帶了長度、fallback 沒帶 —— 於是哪一條先執行,
 * 它挑選的版本便佔住快取,另一條之後整整七天都取得對不上的時間軸。
 *
 * 合併為一支之後,「要查詢什麼」只寫一次,不可能再分岔。
 */
function askForLyrics(nowPlaying) {
  const durationMs = getDurationMs();
  return chrome.runtime.sendMessage({
    type: 'FETCH_LYRICS',
    ...nowPlaying,
    durationSec: durationMs ? Math.round(durationMs / 1000) : undefined,
  });
}

/** 向 service worker 索取這首歌的時間軸 */
async function requestLrc(nowPlaying, key) {
  if (lrcAskedFor === key) return;
  lrcAskedFor = key;

  try {
    const res = await askForLyrics(nowPlaying);

    if (res?.timedOut) {
      lrcAskedFor = null; // 逾時不算查詢過,下次仍可再試
      return;
    }
    if (!res?.synced) {
      console.info(`${LOG} LRCLIB 沒有這首歌的時間軸,高亮改用觀察畫面的方式`);
      noticeNoTimeline(
        '這首歌沒有同步歌詞',
        // 換行是刻意的:兩件事分開陳述才看得清楚(overlay.css 以 pre-line 保留)
        '拼音照常顯示,但不會跟著歌聲逐字亮。\n設定裡的「延遲校正」拖了也不會有變化。'
      );
      return;
    }

    const parsed = parseLrc(res.synced);
    if (!parsed.lines.length) return;

    pendingLrc = parsed.lines;
    alignedCount = 0; // 迫使下一輪重新對齊
  } catch (err) {
    console.warn(`${LOG} 取得時間軸失敗:`, err);
    lrcAskedFor = null;
  }
}

/**
 * 將 LRC 的句子對應至畫面上的行。
 * 對應結果過差即整個放棄 —— 錯位的高亮比沒有高亮更糟。
 */
function alignIfNeeded(lines) {
  if (!pendingLrc || lines.length === alignedCount) return;
  alignedCount = lines.length;

  const { times, words, matchRate } = alignLrc(pendingLrc, lines.map(readLineText));

  if (matchRate < 0.5) {
    console.info(
      `${LOG} 時間軸跟畫面上的歌詞對不上(只對到 ${Math.round(matchRate * 100)}%),` +
        '可能不是同一個版本,高亮改用觀察畫面的方式'
    );
    setLineTimes(null);
    pendingLrc = null;
    noticeNoTimeline(
      '這首歌的同步歌詞對不上',
      '找到的時間軸可能是別的版本(Live、重製或不同剪輯)。拼音照常顯示,但不會跟著歌聲逐字亮。' +
        '\n設定裡的「延遲校正」拖了也不會有變化。'
    );
    return;
  }

  setLineTimes(fillGaps(times));
  lineCurves = words.map(buildWordCurve);

  const withWords = lineCurves.filter(Boolean).length;
  console.info(
    `${LOG} 時間軸已對齊(${Math.round(matchRate * 100)}%),高亮改用播放進度驅動。` +
      (withWords
        ? `其中 ${withWords} 句有逐字時間軸,那幾句走真資料掃描`
        : '沒有逐字時間軸,句內進度改用句距估算(先天不精確,只求跟得上)')
  );
}

/*
 * ---- 沒有逐字時間軸時,估算式掃描的兩道防護 ----
 *
 * 這兩個值皆非為了「估得更準」—— 僅有句首時間時那做不到。
 * 它們的用途是讓估錯時不致錯得太離譜。
 */

/**
 * 掃描比實際句距略快一些收尾。
 *
 * 演唱時句中會有換氣與小停頓,真正的演唱時間比句距短,
 * 故依句距等速掃描會偏慢、整句唱完了仍剩一截未掃到。
 * 乘上一個略小於 1 的係數,使掃描恰好在下一句開始前收尾。
 */
const SWEEP_SPAN_FACTOR = 0.92;

/*
 * 「每個字母至多值得掃描多少毫秒」已移至設定中(settings.sweepMsPerLetter),
 * 可於 popup 一邊播放一邊拖曳。
 *
 * 不寫死的原因:合適的值取決於該首歌的演唱速度,而那是每首歌皆不相同的。
 * 先前寫死 180 僅是一個推測,且要驗證其是否正確非得盯著畫面看不可 ——
 * 與其在此反覆推測,不如讓使用者當場調整至看起來正確為止。
 * 這與 syncOffsetMs 是同一個判斷。
 */

/** 這一行的拼音有幾個字母 —— 用以估算「至多值得掃描多久」 */
function countRomajiLetters(lineEl) {
  const overlay = lineEl.querySelector(':scope > .romaji-overlay');
  return overlay ? overlay.querySelectorAll('.romaji-ch').length : 0;
}

/**
 * 僅更新「目前唱到哪一行、唱到哪個字」。
 * 這件事的頻率須遠高於掃描:它同時決定了畫面上的高亮與佇列的優先順序。
 */
function updateActiveLine() {
  if (!isEnabled()) return;

  const lines = [...document.querySelectorAll(LINE_SELECTOR)];

  // 沒有 Spotify 歌詞、但 LRCLIB 面板開啟中:高亮改由面板自行計算。
  //
  // 面板毋須 alignLrc —— 那一步是為了「將 LRC 的句子對應至畫面上的行」,
  // 而面板的行本就是依 LRC 建立的,一對一,不可能對錯。
  if (!lines.length) {
    if (isLrcPanelOpen()) {
      const raw = getPositionMs();
      updateLrcPanel(raw === null ? null : raw + settings.syncOffsetMs, {
        spanFactor: SWEEP_SPAN_FACTOR,
        sweepMsPerLetter: settings.sweepMsPerLetter,
      });
    }
    return;
  }

  alignIfNeeded(lines);

  const raw = lineTimes ? getPositionMs() : null;
  if (raw === null) {
    markActive(lines); // 退路:觀察畫面
    return;
  }

  /*
   * 時間軸是唯一的真相來源,不去參考 Spotify 自身那個高亮。
   *
   * 曾嘗試反過來:換句的時機聽從 Spotify,理由是「它的時鐘與音訊
   * 必然同步」。實測結果是錯的 —— 它畫面上的高亮比歌聲慢上數秒,跟隨它
   * 之後拼音整個變成慢半拍。它的高亮遲到這件事,反過來說明了先前
   * 「拼音掃過去了、日文才慢慢轉白」根本不是拼音太早,而是它太晚。
   *
   * 故解法不是更換時間來源,而是不讓那個遲到的高亮被看見 ——
   * 見 overlay.css 中 data-romaji-synced 那一段。
   */
  const position = raw + settings.syncOffsetMs;

  const active = activeIndexAt(lineTimes, position);

  /*
   * 逐字掃描的兩條路徑。
   *
   * 有逐字時間軸(enhanced LRC)時走 progressFromCurve —— 那是真實資料,精準。
   * 沒有的時候改用 progressAt 依句距估算。
   *
   * 此處須說明清楚:估算先天無法精確。僅有句首時間時,「唱得快」與
   * 「唱得慢」的句子在資料上完全相同,不論如何調整參數都只能在兩種誤差之間
   * 換邊,無法消除。故下方兩個參數的用途並非「使其變準」(做不到),
   * 而是將其出錯的幅度限制住,使掃描即便不精確亦仍跟得上。
   */
  const curve = active >= 0 ? lineCurves[active] : null;
  let progress = null;

  if (active >= 0) {
    if (curve) {
      progress = progressFromCurve(curve, position, nextTimeAfter(active));
    } else {
      const letters = countRomajiLetters(lines[active]);
      progress = progressAt(lineTimes, active, position, {
        spanFactor: SWEEP_SPAN_FACTOR,
        maxSpanMs: letters ? letters * settings.sweepMsPerLetter : Infinity,
      });
    }
  }

  /*
   * 此處曾有一個「掃描快慢」的倍率,完成後即移除 —— 詳見 settings.js
   * 的說明。簡言之:調快會使字掃到底後停在句尾等待,調慢會在唱完換行時
   * 被截斷。一句唱多久由歌曲本身決定,掃描的正確行為只有一種。
   *
   * 要調整感受請使用 syncOffsetMs,它會使整句與逐字一併平移。
   */

  lines.forEach((el, i) => {
    if (i === active) {
      if (el.dataset.romajiActive !== 'true') el.dataset.romajiActive = 'true';
      paintSweep(el, progress);
    } else {
      if (el.dataset.romajiActive) delete el.dataset.romajiActive;
      paintSweep(el, null);
    }
  });

  /*
   * Spotify 的捲動與它的高亮同樣是遲到的,故換句之後它經常尚未將
   * 這一句帶回畫面中央。稍候片刻,仍未到位即自行補捲。
   *
   * 僅在走時間軸這條路徑時才執行。另一條路徑(上方的 markActive 退路)是靠
   * 觀察畫面判斷正在演唱哪一行的,而其中一項策略即是「何者最接近畫面中央」——
   * 在該路徑上自動置中會成為自問自答。具備獨立的時間來源時才有資格介入捲動。
   */
  if (active >= 0) centerActiveLine(lines[active]);
}

/**
 * 目前要處理的是哪一組歌詞行。
 *
 * Spotify 自身有歌詞即採用它的;完全沒有時(paywall、冷門曲目)
 * 才輪到 LRCLIB 面板。兩者不會同時存在 —— 面板本就只在
 * 「等不到任何歌詞行」時才開啟,而歌詞一旦出現 tick() 便會將面板關閉。
 *
 * 抽出為一個函式是為了讓佇列的優先順序邏輯毋須知道歌詞來自何處:
 * 不論何種來源,「正在演唱的那一行先轉換」都是同一套規則。
 */
function currentLineElements() {
  const spotify = [...document.querySelectorAll(LINE_SELECTOR)];
  if (spotify.length) return spotify;
  return isLrcPanelOpen() ? getPanelLineElements() : [];
}

function scanNow() {
  if (!isEnabled()) return;
  const lines = currentLineElements();

  // 先確認目前唱到哪一行,pickNext 才有依據。
  //
  // 但有時間軸可用時絕對不可在此標記:該路徑是由 updateActiveLine
  // 每 80ms 依播放進度寫入 data-romaji-active,此處每秒再以觀察畫面的方式
  // 寫入同一個屬性,兩端便會每秒衝突一次 —— 畫面上所見即為高亮閃爍。
  // 面板的高亮是 updateLrcPanel 依 LRC 時間軸自行標記的。
  // markActive 是讀取 Spotify 內層元素的樣式來判斷的,面板上沒有那些元素,
  // 讓它介入只會將面板已標記好的 data-romaji-active 清除。
  if (!lineTimes && !isLrcPanelOpen()) markActive(lines);

  for (const lineEl of lines) {
    if (needsProcessing(lineEl)) enqueue(lineEl);
  }
}

/*
 * 具備 leading edge 與上限等待時間的 debounce。
 *
 * 純 trailing debounce 在此會被餓死:observer 掛在 document.body 上,
 * 進度條、卡拉 OK 逐字高亮這類元素的變動頻率高於 DEBOUNCE_MS,
 * 每一次都將計時器重置,結果可能永遠等不到掃描。
 *
 * lastScanAt  距上次實際掃描已夠久 → 立即掃描(leading edge)
 * firstPendingAt  持續被重置但已拖延過久 → 強制掃描(maxWait)
 */
function scanSoon() {
  const now = performance.now();

  if (now - lastScanAt >= MAX_WAIT_MS) {
    runScan();
    return;
  }
  if (firstPendingAt === 0) firstPendingAt = now;
  if (now - firstPendingAt >= MAX_WAIT_MS) {
    runScan();
    return;
  }

  clearTimeout(scanTimer);
  scanTimer = setTimeout(runScan, DEBOUNCE_MS);
}

function runScan() {
  clearTimeout(scanTimer);
  scanTimer = null;
  firstPendingAt = 0;
  lastScanAt = performance.now();
  scanNow();
}

/* ------------------------------------------------------- 監控歌詞容器 */

/**
 * 歌詞檢視是否已開啟?
 *
 * 這是 fallback 判斷的關鍵。歌詞面板預設為關閉,使用者須按下歌詞鈕才會出現 ——
 * 「找不到 lyrics-container」絕大多數時候僅代表「面板尚未開啟」,
 * 不代表「這首歌沒有歌詞」。唯有在使用者確實開啟了歌詞檢視、
 * 卻等不到任何歌詞行時,才有資格向 LRCLIB 查詢。
 */
function isLyricsViewOpen() {
  const button = document.querySelector(LYRICS_BUTTON_SELECTOR);
  if (button) {
    const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('data-active');
    if (pressed !== null) return pressed === 'true';
  }
  // 找不到按鈕(Spotify 改版)即退回檢視畫面上是否有歌詞行
  return Boolean(document.querySelector(LINE_SELECTOR));
}

/**
 * 每秒執行一次的單一迴圈,取代原本「遞迴 setTimeout 加上另一個 watchdog interval」的雙軌寫法。
 * emptyTicks 僅在「歌詞檢視已開啟但尚無歌詞行」時累加,面板未開啟時會歸零。
 */
function tick() {
  // 擴充功能重新載入之後這份 script 即已無用,繼續執行只會持續產生錯誤
  if (!isExtensionAlive()) {
    shutdown();
    return;
  }

  // 播放列被 React 重建時按鈕會被丟棄,每次都確認一次位置。
  // 即使目前為 'off' 亦須維持這顆按鈕,否則使用者無法自頁面上開回。
  syncToggleButton(() => settings.displayMode, cycleDisplayMode);

  // 換歌時舊的時間軸完全沒有意義,須整組丟棄重來
  const nowPlaying = readNowPlaying();
  const trackKey = nowPlaying ? `${nowPlaying.trackName}|${nowPlaying.artistName}` : null;
  if (trackKey !== currentTrackKey) {
    currentTrackKey = trackKey;

    /*
     * 共用字典中部分條目是限定這首歌的,換歌即須更換一套。
     *
     * 唯有在這首歌確實有專屬條目(或上一首有)時才回傳 true,那時
     * onCorrectionsChanged 會將畫面重轉一次。絕大多數歌曲沒有專屬條目,
     * 回傳 false、不做任何事 —— 否則每次換歌都白重轉一次,頁面會卡頓。
     */
    setCurrentSong(nowPlaying?.trackName ?? '');

    resetLrcState();
    lrcAskedFor = null;
    emptyTicks = 0;
    fallbackAskedFor = null;
    panelDismissedFor = null; // 上一首關閉了不代表這一首也不想看
    closeLrcPanel();
    // 修正面板是綁在某一句上的,換歌之後那一句已不在畫面上
    closeCorrectionPopover();
  }

  // React 換頁時有整批清理的動作,面板遭移除須補回
  ensurePanelAttached();
  // 畫面上有歌詞才需要時間軸(沒有歌詞的歌走的是另一條 LRCLIB fallback)
  if (trackKey && nowPlaying && document.querySelector(LINE_SELECTOR)) {
    requestLrc(nowPlaying, trackKey);
  }

  // 每秒無條件掃描一次作為安全網。
  // 一定要用 scanNow 而非 scanSoon —— 會被 debounce 的安全網不算安全網。
  // observer 若因任何原因漏接(記錄被過濾、React 採用了未被觀察到的手法),
  // 最壞情況也只是慢一秒,不會永遠不更新。
  scanNow();

  const lineCount = document.querySelectorAll(LINE_SELECTOR).length;

  if (lineCount > 0) {
    emptyTicks = 0; // 有歌詞,一切正常
    // Spotify 的歌詞稍後才載入(先前只是較慢或仍在載入),即將面板收起 ——
    // 兩份歌詞同時置於畫面上只會相互干擾,且 Spotify 那一份與畫面是同步的
    if (isLrcPanelOpen()) {
      console.info(`${LOG} Spotify 的歌詞出現了,收起 LRCLIB 面板`);
      closeLrcPanel();
    }
  } else if (isLyricsViewOpen()) {
    emptyTicks += 1; // 面板開啟卻是空的 —— 可能是 paywall、沒有歌詞,或仍在載入
    /*
     * 用 >= 而非 ===。
     *
     * 嚴格相等代表「只有第 N 秒那一瞬間會嘗試」,而 tryLrclibFallback 前方
     * 有三道會提早退出的關卡(轉換關閉中、讀不到曲名、已經問過)。前兩道
     * 一旦剛好發生在那一秒,這首歌就再也不會嘗試 —— 計數只會往上加,
     * 永遠回不到 N。使用者得換歌或關掉再開歌詞檢視才會重新計時,
     * 而他不會知道要這樣做。
     *
     * 改為 >= 之後每秒都會再試一次,重複請求由 fallbackAskedFor 擋掉,
     * 只有前兩道關卡造成的落空會真正重試 —— 那兩者都只是本地檢查,很便宜。
     */
    if (emptyTicks >= FALLBACK_AFTER_TICKS) tryLrclibFallback();
  } else {
    emptyTicks = 0; // 面板根本未開啟,不可下任何結論

    /*
     * 使用者已將歌詞檢視關閉,本擴充功能的面板亦應隨之收起 ——
     * 他要的是「現在不想看歌詞」,而非「不想看 Spotify 的歌詞」。
     *
     * 但此處刻意只認可明確的否定:isLyricsViewOpen 找不到歌詞按鈕時
     * 會退回檢視畫面上是否有歌詞行,而面板開啟時該判斷必然為 false。
     * 逕自相信它的話,在找不到按鈕的 Spotify 版本上,面板會在開啟的下一秒
     * 便自行關閉 —— 使用者只會看到它閃一下。
     */
    if (isLrcPanelOpen() && lyricsViewExplicitlyClosed()) closeLrcPanel();
  }
}

/**
 * 歌詞檢視確定是關閉的嗎?
 *
 * 與 isLyricsViewOpen() 的差別在於「不確定」時的處理方式:該函式在找不到
 * 按鈕時會以歌詞行數推測,本函式則回傳 false(不確定即視為未關閉)。
 * 因為此處要做的是關閉面板 —— 猜錯的代價是把使用者正在檢視的內容弄不見。
 */
function lyricsViewExplicitlyClosed() {
  const button = document.querySelector(LYRICS_BUTTON_SELECTOR);
  if (!button) return false;
  const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('data-active');
  return pressed === 'false';
}

/** 本擴充功能自行插入頁面的元素。來自這些元素的變動不應再觸發掃描 */
const OWN_ELEMENTS = '.romaji-overlay, .romaji-original, .romaji-toggle, .romaji-lrc-panel';

/**
 * 這一筆變動是本擴充功能自身造成的嗎?
 *
 * 須過濾的原因:observer 掛在 document.body 上,而自身每插入一個 overlay、
 * 每重繪一次拼音(使用者每點一下切分都會重繪)都會產生 childList 記錄,
 * 那些記錄又會將 debounce 的計時器重置 —— 自己餵自己,永遠掃描不到。
 */
function isOwnRecord(record) {
  const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
  if (el?.closest?.(OWN_ELEMENTS)) return true;

  if (record.type === 'childList') {
    const touched = [...record.addedNodes, ...record.removedNodes];
    return touched.length > 0 && touched.every((n) => n.nodeType === 1 && n.matches?.(OWN_ELEMENTS));
  }
  return false;
}

/*
 * 擴充功能重新載入(或停用、更新)之後,已開啟的分頁中這份 script
 * 會成為孤兒:程式仍在執行,但 chrome.* API 全數失效。
 *
 * 不處理的話,每秒的 tick 與 80ms 的高亮迴圈會持續觸及 chrome.storage,
 * console 便被 "Extension context invalidated" 洗版。
 * 偵測到即自行收拾,靜候使用者重新整理頁面。
 */
function isExtensionAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let timers = [];

function shutdown() {
  for (const id of timers) clearInterval(id);
  timers = [];
  observer?.disconnect();
  observer = null;
  stopClock();
  resetAutoScroll();
  hideNotice();
  closeCorrectionPopover();
  // 面板留在畫面上卻已無任何機制在更新它,那比沒有面板更具誤導性
  closeLrcPanel();
  console.info(`${LOG} 擴充功能已重新載入,此分頁的舊實例停止運作(重新整理頁面即可恢復)`);
}

/**
 * 歌詞行沒有共同、帶專屬 data-testid 的祖先容器可供掛載 observer,
 * 故改為掛在 document.body 上一次即可,毋須隨容器更換而重新掛載。
 */
function startWatching() {
  observer = new MutationObserver((records) => {
    // ensureOriginalWrapper 搬移的是 React 自身的節點,靠 isOwnRecord 辨識不出,
    // 故該期間直接整批略過。如此做法安全的前提是 tick() 每秒
    // 無條件執行 scanNow() —— 萬一真的漏掉一筆,至多慢一秒。
    if (selfMutating > 0) return;
    if (records.every(isOwnRecord)) return;
    scanSoon();
  });

  // characterData 不可省略:將原文包入 .romaji-original 之後,那個文字節點
  // 便固定不動,React 更換句子時是直接修改 nodeValue —— 這不會發出
  // childList 記錄,只發出 characterData。缺少它便完全收不到換句的通知。
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // 高亮須另以較快的節奏更新。
  // 掛在 tick(1 秒)上的話,平均會慢半秒才換行 —— 跟唱時十分明顯。
  // 這個迴圈只做標記、不做轉換,成本很低(而且 findActiveIndex 內部還有快取)。
  timers.push(setInterval(updateActiveLine, ACTIVE_TICK_MS));

  tick();
  timers.push(setInterval(tick, TICK_MS));
}

/* ------------------------------------------------- LRCLIB fallback(僅 API) */

/** 自播放列讀出目前的曲目資訊。Spotify 改版過數次,故列出數個備援選擇器。 */
function readNowPlaying() {
  const widget = document.querySelector('[data-testid="now-playing-widget"]');
  if (!widget) return null;

  const trackEl =
    widget.querySelector('[data-testid="context-item-link"]') ||
    widget.querySelector('[data-testid="nowplaying-track-link"]') ||
    widget.querySelector('a[href^="/track/"]');
  const artistEl =
    widget.querySelector('[data-testid="context-item-info-artist"]') ||
    widget.querySelector('a[href^="/artist/"]');

  const trackName = trackEl?.textContent?.trim();
  const artistName = artistEl?.textContent?.trim();
  if (!trackName || !artistName) return null;
  return { trackName, artistName };
}

/**
 * 歌詞檢視開啟中、但等待 FALLBACK_AFTER_TICKS 秒仍一行都沒有時
 * (paywall 或該曲確實沒有歌詞),改請 service worker 向 LRCLIB 查詢,
 * 查到即開啟一個自有的浮動面板將歌詞顯示出來。
 *
 * ── 本 fallback 的適用範圍 ────────────────────────────────
 * 觸發條件是「面板開啟卻等不到任何歌詞行」,故它所處理的是
 * Spotify 根本沒有這首歌的歌詞。它並非「更換一個歌詞來源」——
 * Spotify 有歌詞時此處永遠不會被呼叫到。
 * 日後若欲改為優先採用 LRCLIB,要修改的是 tick() 中的觸發條件,而非此處。
 */
async function tryLrclibFallback() {
  if (!isEnabled()) return;

  const nowPlaying = readNowPlaying();
  if (!nowPlaying) return;

  const key = `${nowPlaying.trackName}|${nowPlaying.artistName}`;
  if (fallbackAskedFor === key) return;
  fallbackAskedFor = key;

  console.info(`${LOG} 歌詞面板開著但 ${FALLBACK_AFTER_TICKS} 秒內沒有任何歌詞,改問 LRCLIB:`, key);

  try {
    // 一定要走 askForLyrics —— 此處若自行組裝訊息便會遺漏曲目長度,
    // 而長度決定了 service worker 挑選哪個版本(見 askForLyrics 的說明)
    const res = await askForLyrics(nowPlaying);
    if (res?.timedOut) {
      console.warn(`${LOG} LRCLIB 查詢逾時,再等 ${FALLBACK_AFTER_TICKS} 秒後重試`);
      /*
       * 逾時不算查詢過,允許重試 —— 但兩行要一起寫。
       *
       * 只清掉 fallbackAskedFor 的話,上面的 `emptyTicks >= FALLBACK_AFTER_TICKS`
       * 已經永遠成立,於是下一秒就會再問一次、再逾時、再清掉 ——
       * 變成一個沒有煞車的重試迴圈,而對象是別人免費提供的服務。
       * (service worker 那邊的 inFlight 會把同時進來的請求併成一個,
       *  所以不至於每秒真的送出一次,但沒有上限這件事本身就不該留著。)
       *
       * 把計數歸零,它就要重新等滿一輪才會再試,retry 才有節制。
       */
      fallbackAskedFor = null;
      emptyTicks = 0;
      return;
    }
    if (!res?.lines?.length && !res?.synced) {
      console.info(`${LOG} LRCLIB 也沒有這首歌的歌詞`);
      return;
    }

    // 這段 await 期間使用者可能已經換歌、關閉歌詞檢視,或 Spotify 的歌詞
    // 終於載入完成。任何一種情況下開啟面板都是錯的。
    if (key !== currentTrackKey || panelDismissedFor === key) return;
    if (document.querySelector(LINE_SELECTOR)) return;

    // 有時間軸即採用時間軸(才做得出高亮與逐字掃描),沒有則退回純文字
    const timed = res.synced ? parseLrc(res.synced).lines : null;

    const lineEls = openLrcPanel({
      title: nowPlaying.trackName,
      subtitle: `${nowPlaying.artistName} · 歌詞來自 LRCLIB${res.cached ? '(快取)' : ''}`,
      timed: timed?.length ? timed : null,
      plain: res.lines ?? null,
      onClose: () => {
        // 記住他已關閉,不要下一秒又自行彈回
        panelDismissedFor = key;
      },
    });

    // 面板的行走的是與 Spotify 歌詞完全相同的轉換流程,
    // 故此處只要將它們送入同一個佇列即可,毋須另寫一套。
    for (const el of lineEls) enqueue(el);
  } catch (err) {
    console.warn(`${LOG} 呼叫 service worker 失敗:`, err);
  }
}

/* ------------------------------------------------------------------ 啟動 */

async function main() {
  settings = await getSettings();
  applySettings();

  // 不等歌詞面板開啟即先讓 kuroshiro 開始載入辭典(README 限制 #2)
  ready.catch(() => {});

  registerSplitInteractions();

  /*
   * 索取一份共用字典。
   *
   * 刻意不等待它 —— 取得字典須連網,而使用者已經在看歌詞了。
   * 讓轉換先以內建字典運作,字典回來之後若確實有變動,
   * 下方的訂閱會收到通知並重轉一次。
   *
   * 取不到即取不到:內建那一份仍在,只是少了新收錄的詞。
   */
  loadSharedDictionary().catch(() => {});

  /*
   * 使用者新增或刪除自訂讀音之後,畫面須立即反映。
   *
   * 三件事缺一不可:清除轉換結果的快取、移除所有行的處理旗標、重新掃描。
   * 缺少第一項會取得舊的轉換結果;缺少第二項則 needsProcessing 會判定
   * 「這一行已處理過」而不重轉。
   *
   * 已儲存的手動切分毋須處理 —— splitter.js 以 letters 作為校驗碼,讀音變更
   * 即對不上而自動作廢,不會把空格插到錯誤的位置。
   */
  onCorrectionsChanged(() => {
    invalidateRomajiCache();
    reconvertEverything();
  });

  // 高亮須由播放進度驅動,時鐘必須自一開始便運轉
  startClock();

  startWatching();
}

main();
