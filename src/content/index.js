/**
 * content/index.js
 * Chrome Extension 的 content script,注入 open.spotify.com。
 *
 * 取代原本的 content.js(現在放在 legacy/),主要差異:
 * - 轉換改用 kuroshiro,漢字也會被轉出來(原本只用 wanakana,漢字會原樣留著)
 * - kuroshiro 是非同步的,所以處理流程改成佇列 + 提前上鎖,避免重複轉同一行
 * - MutationObserver 加了 debounce,換歌/關閉面板時會解除再重新掛上
 * - 顯示模式(上/下/只顯示拼音)交給 CSS,切設定不需要重新轉換
 */

import { toRomaji, toKana, ready, invalidateRomajiCache } from './romaji.js';
import { findUnromanized, findUnreadKanji, toLetterRanges } from './cjk.js';
import { onCorrectionsChanged, loadSharedDictionary } from './corrections-store.js';
import {
  openCorrectionPopover,
  closeCorrectionPopover,
  handleOutsideClick,
} from './correction-popover.js';
import { syncToggleButton, renderToggleButton } from './toggle-button.js';
import { markActive } from './active-line.js';
import { centerActiveLine, resetAutoScroll } from './auto-scroll.js';
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
// 容器本身已經沒有專屬的 data-testid 了(Spotify 改版),
// 所以不再靠容器選擇器抓歌詞區塊,直接抓歌詞行、observer 掛在 document.body 上。
const LINE_SELECTOR = '[data-testid="lyrics-line"]';
const LYRICS_BUTTON_SELECTOR = '[data-testid="lyrics-button"]';

const PROCESSED_FLAG = 'data-romaji-processed'; // pending | done | skipped | empty
const DEBOUNCE_MS = 100;
// 連續變動時最多拖這麼久就一定要掃一次,避免被高頻變動餓死
const MAX_WAIT_MS = 350;
const TICK_MS = 1000;
// 高亮的更新節奏。逐字掃過去要夠細才會順,
// 但 paintSweep 在沒變化時會直接返回,所以跑得快也不貴。
const ACTIVE_TICK_MS = 80;

// 高亮提前量搬到設定裡了(settings.syncOffsetMs),可以在 popup 即時調整。
// 這個值沒有放諸四海皆準的答案 —— 音訊緩衝、顯示延遲、個人偏好都會影響,
// 所以與其寫死一個數字反覆猜,不如讓使用者自己對到準為止。

/*
 * 註:先前這裡有一組「用字數估演唱速度」的常數,用來推測句子內部的進度。
 * 已經拿掉了 —— 只有句首時間的話,「唱得快」跟「唱得慢」的句子在資料上
 * 完全一樣,那組估算不管怎麼調都只是在兩種誤差之間換邊。
 * 現在改成:有逐字時間軸就精準掃描,沒有就整句一起亮。
 */
// 歌詞檢視已經打開、卻連續這麼多秒都等不到任何一行,才去問 LRCLIB。
// 給足時間讓 Spotify 自己把歌詞載進來,不要太快下結論。
const FALLBACK_AFTER_TICKS = 12;

let settings = { ...DEFAULTS };
let observer = null;
let scanTimer = null;
let firstPendingAt = 0; // 這一串連續變動最早是什麼時候開始等的(0 = 沒在等)
let lastScanAt = 0; // 上一次真的掃描的時間
let selfMutating = 0; // >0 代表現在的 DOM 變動是我們自己造成的,observer 要略過
let emptyTicks = 0;
let fallbackAskedFor = null; // 已經問過 LRCLIB 的曲目 key,避免重複請求
let currentTrackKey = null; // 目前這首歌,用來偵測換歌
let panelDismissedFor = null; // 使用者手動關掉面板的曲目 key,同一首不再自動打開

/* ---------------------------------------------------------------- 設定 */

/** displayMode 為 'off' 時完全不做轉換,也不插入任何羅馬拼音元素 */
function isEnabled() {
  return !isConversionOff(settings.displayMode);
}

function applySettings() {
  const root = document.documentElement;
  root.setAttribute('data-romaji-mode', settings.displayMode);

  /*
   * 外觀走 CSS 變數,不是直接改每個元素的樣式。
   *
   * 兩個好處:改設定時只動一個地方(不必走訪幾十行歌詞),而且
   * **不需要重新轉換** —— 顏色跟大小純粹是顯示,跟拼音的內容無關。
   *
   * 值一定要先過 normalize:那份設定是跨裝置同步的,不是只有本機,
   * 直接把儲存裡的字串塞進樣式等於讓外部資料影響頁面。
   */
  root.style.setProperty('--romaji-color', normalizeColor(settings.romajiColor));
  root.style.setProperty('--romaji-scale', String(normalizeScale(settings.romajiScale)));
}

/**
 * 頁面上那顆按鈕的點擊處理。
 * 只負責寫進 storage —— 按鈕外觀交給下面的 onChanged 統一更新,
 * 這樣頁面按鈕與 popup 單選鈕永遠反映同一份已儲存的狀態,不會各自為政。
 */
async function cycleDisplayMode() {
  try {
    await setSetting('displayMode', nextMode(settings.displayMode));
  } catch (err) {
    console.warn(`${LOG} 寫入設定失敗:`, err);
  }
}

// popup 或頁面按鈕任一邊改了設定,這裡都會收到
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  // 提前量是即時生效的:下一次 updateActiveLine 就會用新值,
  // 所以使用者拖滑桿時可以一邊聽一邊對準,不必重新整理
  if (changes.syncOffsetMs) {
    settings.syncOffsetMs = normalizeOffset(changes.syncOffsetMs.newValue);
  }
  if (changes.sweepMsPerLetter) {
    settings.sweepMsPerLetter = normalizeSweepMs(changes.sweepMsPerLetter.newValue);
  }

  // 外觀是純顯示,套用 CSS 變數就好 —— 不必重新轉換,所以拖色盤是即時的
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
   * 拼音 ↔ 平假名要重新轉換,拼音的兩種顯示方式之間則不必。
   *
   * romaji-only 與 both 的差別純粹是 CSS,已經轉好的內容照用就好。
   * 但平假名要的是另一份文字,不重轉的話畫面上會停在舊的那一種 ——
   * 而且因為旗標還是 'done',它永遠不會自己更新。
   *
   * 反過來說也不能無條件重轉:整批重跑斷詞會讓頁面卡住好幾秒,
   * 只是為了換個顯示方式不值得。
   */
  if (conversionKind(settings.displayMode) !== before) reconvertEverything();

  // 從「關閉」切回其他模式時,期間出現的歌詞行都還沒轉過,補掃一次
  if (isEnabled()) scanSoon();
});

/**
 * 把所有已處理的行打回未處理,重新走一次轉換。
 *
 * 兩件事缺一不可:把處理旗標拿掉、重新掃描。少了旗標那一步,
 * needsProcessing 會判定「這行已經處理過了」而不重轉。
 *
 * 注意這裡**不清** romaji.js 的轉換快取,那是呼叫端的責任:
 * 換轉換種類不必清(快取的 key 帶著種類,兩種答案本來就分開存),
 * 但改了自訂讀音就一定要清,否則拿回來的還是舊讀音。
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
 * 把原本的內容包進 .romaji-original,讓 CSS 可以獨立控制原文與拼音的順序/顯示。
 * 用搬移子節點而不是覆寫 innerHTML,避免破壞 Spotify 自己的內層結構。
 */
function ensureOriginalWrapper(lineEl) {
  let original = lineEl.querySelector(':scope > .romaji-original');
  if (!original) {
    original = document.createElement('span');
    original.className = 'romaji-original';
    // 搬的是 React 自己的子節點,產生的變動記錄從外面看跟真的內容變動
    // 分不出來,所以先舉旗告訴 observer「這段是我幹的」
    selfMutating += 1;
    try {
      while (lineEl.firstChild) original.appendChild(lineEl.firstChild);
      lineEl.appendChild(original);
    } finally {
      // observer callback 是在 microtask 跑的,要等它看完這一批才降旗
      queueMicrotask(() => {
        selfMutating -= 1;
      });
    }
  }
  return original;
}

/**
 * 確保這一行有拼音容器,並回傳它。
 *
 * 刻意在「送去轉換之前」就建好、而且是空的 —— CSS 會替空的 overlay
 * 預留一行高度,這樣拼音填進來時整行不會突然撐開造成畫面跳動。
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
 * 真的有拼音之後才讓它可以被 Tab 選到。
 * 空的容器就開放焦點的話,Tab 順序會多出一堆按了沒反應的停留點。
 */
function makeOverlayInteractive(overlay) {
  if (overlay.tabIndex === 0) return;
  overlay.tabIndex = 0;
  overlay.setAttribute('role', 'textbox');
  overlay.setAttribute('aria-label', '羅馬拼音,可點擊或用左右鍵移動游標、空白鍵切分、Enter 完成');
}

/**
 * 這一行「現在的原文」是什麼。
 *
 * 一定要走 .romaji-original,不能用 lineEl.textContent —— 包起來之後
 * 後者是「原文 + 拼音」黏在一起,拿去跟 romajiSource 比對永遠不相等,
 * 會變成每一行無限重轉。
 */
/**
 * 走訪節點,同時取出「原文」與「把振假名換上去之後的文字」。
 *
 * Spotify 有些歌詞帶振假名,結構是 <ruby>藻掻<rt>もが</rt></ruby>いて。
 * 直接讀 textContent 會把注音也串進來變成「藻掻もがいて」——
 * 那是一段根本不存在的文字,kuromoji 當然轉不對。
 *
 * 但反過來看,那個 <rt> 就是**權威讀音**,比 kuromoji 猜的可靠得多。
 * 所以這裡一次取兩份:
 *   plain   給畫面顯示、當儲存的 key、popover 顯示用(乾淨的原文)
 *   reading 把漢字換成振假名之後的文字,拿去做轉換
 * 等於每一行都自帶一份正確的讀音表。
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
    if (tag === 'rt' || tag === 'rp') continue; // 注音本身不算原文

    if (tag === 'ruby') {
      const inner = extractRuby(node); // 已經排除 rt/rp,拿到的是底下的漢字
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
 * 一定要走 .romaji-original,不能用 lineEl.textContent —— 包起來之後
 * 後者是「原文 + 拼音」黏在一起,拿去跟 romajiSource 比對永遠不相等,
 * 會變成每一行無限重轉。
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

/** 這一行還是我們當初開始處理的那一行、那段文字嗎? */
function isCurrent(lineEl, text) {
  return lineEl.isConnected && lineEl.dataset.romajiSource === text;
}

/**
 * 判斷這一行需不需要(重新)處理。
 *
 * Spotify 是 React SPA,而且歌詞是虛擬列表 —— 元素會被回收重用,
 * 把新的一句寫進舊的元素裡。所以「有沒有旗標」完全不足以判斷,
 * 每一種狀態都必須先比對文字有沒有變。
 *
 * 順序很重要:文字比對要排在 pending 短路之前,
 * 否則正在轉換中被回收的元素會卡在舊句子上不再更新。
 */
function needsProcessing(lineEl) {
  const state = lineEl.getAttribute(PROCESSED_FLAG);
  if (!state) return true;

  // 文字換了就一律重來,不管先前是什麼狀態
  if (lineEl.dataset.romajiSource !== readLineText(lineEl)) return true;

  if (state === 'pending') return false; // 同一段文字正在處理中
  if (state === 'done') return !lineEl.querySelector(':scope > .romaji-overlay');
  return false; // 'skipped'(純英文)與 'empty'(空行)對這段文字是終點
}

async function processLyricsLine(lineEl) {
  ensureOriginalWrapper(lineEl);

  // text 是乾淨的原文(當 key、給 popover 用);
  // forConversion 是把振假名換上去之後的文字,只用來轉換
  const { text, forConversion } = readLineParts(lineEl);

  // 空行(間奏)。要標成 'empty' 而不是把旗標拿掉 ——
  // 拿掉的話 needsProcessing 會永遠回 true,每次掃描都白排一次隊。
  // romajiSource 設成空字串,等真的有文字進來時比對就會不相等而重新處理。
  if (!text) {
    lineEl.dataset.romajiSource = '';
    lineEl.setAttribute(PROCESSED_FLAG, 'empty');
    return;
  }

  // 在任何 await 之前先上鎖 —— MutationObserver 會連續觸發,
  // 沒有這行同一句歌詞會被送去轉好幾次。
  lineEl.dataset.romajiSource = text;
  lineEl.setAttribute(PROCESSED_FLAG, 'pending');

  // 在 await 之前就把 overlay 建好。它現在是空的,但 CSS 已經替它
  // 預留了一行的高度 —— 這樣等一下拼音填進來時整行不會突然撐開。
  const overlay = ensureOverlay(lineEl);

  // settled = 已經走到某個終點狀態(done/skipped)。
  // 沒走到就代表中途放棄了,finally 要負責解鎖,否則這一行會永久卡在
  // 'pending',而 needsProcessing 對 pending 回 false —— 永遠不會再有拼音。
  const kind = conversionKind(settings.displayMode);

  let settled = false;
  try {
    const converted = kind === 'kana' ? await toKana(forConversion) : await toRomaji(forConversion);

    // 等待期間 Spotify 可能已經把這個元素換掉或改了內容
    if (!isCurrent(lineEl, text)) return;

    if (!converted) {
      lineEl.setAttribute(PROCESSED_FLAG, 'skipped'); // 純英文行等等
      settled = true;
      return;
    }

    // kuroshiro 給的空格只是預設值;使用者手動切過的話以他切的為準
    const { letters, boundaries: fromKuroshiro } = splitRomaji(converted);

    /*
     * 手動切分只在羅馬拼音模式下有效。
     *
     * 不是懶得做,是**共用同一份儲存會互相破壞**:切點存的是字母索引,
     * 而同一句話的假名字數跟拼音字母數完全不同。拿假名的切點去套拼音
     * (或反過來)只會把空格插在錯的地方,而且因為 letters 校驗碼對不上,
     * 使用者原本存好的拼音切分還會被整批判定過期。
     *
     * 而且假名模式本來就不太需要切分 —— 那是為了拆開長串拉丁字母才有的功能。
     */
    const canSplit = kind === 'romaji';
    const saved = canSplit ? await loadSplits(text, letters) : null;

    if (!isCurrent(lineEl, text)) return;

    /*
     * 標出哪幾個字沒轉出來(kuromoji 不認識的詞會原樣吐出漢字)。
     * 位置要從「字串位置」換算成「字母索引」,因為空白被拿掉了。
     *
     * 兩種模式要找的東西不一樣:拼音模式下任何殘留的日文都是失敗,
     * 但假名模式的輸出本來就整片是假名,只有**漢字**才代表沒讀出來。
     */
    const leftover = kind === 'kana' ? findUnreadKanji(converted) : findUnromanized(converted);
    const unknown = toLetterRanges(converted, leftover);

    if (canSplit) makeOverlayInteractive(overlay);
    renderRomaji(overlay, letters, saved ?? fromKuroshiro, null, unknown);
    lineEl.setAttribute(PROCESSED_FLAG, 'done');
    settled = true;
  } finally {
    // 只在「這一行還是我們鎖的那一行」時才解鎖。
    // 兩個附加條件缺一不可 —— 如果中途放棄正是因為文字被換掉了,
    // 那時新的一輪處理已經重新上鎖,不能把它的 pending 洗掉。
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
 * 兩種操作方式共用同一套切點位置系統(splitter.js 的 boundary),
 * 切換動作也共用同一個 toggleBoundary(),不各寫一套。
 *
 * 滑鼠:點一下就在該處插入/取消空格(原本的行為)。
 * 鍵盤:進入編輯模式後用左右鍵移動游標、空白鍵切換、Enter/Esc 離開。
 */

/** 目前正在鍵盤編輯的那一行,null 代表沒有 */
let editingOverlay = null;

/**
 * 滑鼠按下時焦點會落到 overlay 上,connectFocus 需要分辨
 * 「這次 focus 是滑鼠造成的」還是「使用者按 Tab 切過來的」。
 */
let pointerActive = false;

/** 把目前畫面上的切分寫回 storage */
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

/** 離開編輯模式並存檔(對應需求:Enter / Esc 存進 chrome.storage.local) */
async function exitEditMode() {
  const overlay = editingOverlay;
  if (!overlay) return;

  // 先清狀態,這樣底下 blur() 觸發的 focusout 不會又跑一次
  editingOverlay = null;
  overlay.classList.remove('is-editing');
  setCaret(overlay, null); // 收起游標
  overlay.blur?.();

  await persistSplits(overlay);
}

async function onRomajiClick(event) {
  // 點在修正面板外面就把它關掉。用既有的委派做,不另外掛 listener。
  if (handleOutsideClick(event.target)) return;

  const overlay = event.target?.closest?.('.romaji-overlay');
  if (!overlay) return;

  /*
   * 點到「沒轉出來的字」→ 開修正面板,而不是插空格。
   *
   * 條件裡的「不在編輯模式」不能拿掉:進了鍵盤編輯模式之後,
   * 滑鼠只負責移動游標,這時跳出面板會打斷正在進行的切分操作。
   * 而且在轉不出來的漢字裡插空格本來就沒有意義,所以不損失任何功能。
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
    });
    return;
  }

  /*
   * 平假名模式不接受手動切分 —— 理由見 processLyricsLine 裡的說明
   * (切點是字母索引,假名與拼音的字數不同,共用同一份儲存會互相破壞)。
   *
   * 這道防線不能省:上面 makeOverlayInteractive 沒被呼叫只是不給鍵盤焦點,
   * 擋不住滑鼠點擊。少了這一行,在假名模式點一下就會把假名的切點
   * 寫進拼音的那筆記錄裡。
   *
   * 補讀音的面板則留著 —— 那個判斷排在前面,假名模式一樣看得到
   * 讀不出來的漢字,也一樣該讓使用者當場補。
   */
  if (conversionKind(settings.displayMode) !== 'romaji') return;

  const letters = overlay.dataset.romajiLetters ?? '';
  const boundary = boundaryFromClick(event, letters.length);
  if (boundary === null) return;

  // 攔住,不要讓 Spotify 以為使用者要跳轉播放位置
  event.preventDefault();
  event.stopPropagation();

  const alreadyEditing = editingOverlay === overlay;

  // 編輯模式中,滑鼠只負責移動游標 —— 暫停點擊切分,
  // 免得跟鍵盤操作互相干擾(離開編輯模式後又會恢復)
  enterEditMode(overlay, boundary);
  if (alreadyEditing) return;

  toggleBoundary(overlay, boundary);
  await persistSplits(overlay);
}

/** Tab 切過來也要進編輯模式(滑鼠造成的 focus 交給 click 處理,免得重複) */
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
 * 這一輪按鍵在 keydown 已經被我們吃掉的按鍵代碼。
 *
 * 為什麼需要記下來:Spotify 的播放/暫停快捷鍵是綁在**空白鍵的 keyup**,
 * 不是 keydown,所以只擋 keydown 完全沒用,還是會播放/暫停。
 * 這裡記下「剛剛在編輯模式吃掉的那顆鍵」,再把它後續的
 * keypress / keyup 一起擋掉,精準到單一顆按鍵,
 * 不在編輯模式時這個集合永遠是空的,整個頁面的快捷鍵完全不受影響。
 */
const consumedKeys = new Set();

/** 用 code 而不是 key 當識別,keyup 時的 key 值在某些輸入法下會變 */
function keyId(event) {
  return event.code || event.key;
}

/**
 * 讓修正面板的輸入框重用同一套按鍵防護。
 *
 * 為什麼不讓面板自己寫一套:Spotify 的播放/暫停綁在空白鍵的 **keyup**,
 * 只擋 keydown 沒有用。這個細節已經在編輯模式踩過一次坑了
 * (見 consumedKeys 的說明),不要再實作第二份會走鐘的版本。
 */
function guardEditKey(event) {
  consumedKeys.add(keyId(event));
}

/** 編輯模式下我們自己要處理、不讓 Spotify 看到的按鍵 */
const EDIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Enter', 'Escape']);

/*
 * 注意這個函式**不是 async**,這是刻意的。
 *
 * 事件派送是同步的:一旦函式裡出現 await,剩下的程式碼就變成
 * 之後的 microtask 才跑,那時瀏覽器早就派送完這個事件了 ——
 * 再呼叫 preventDefault() / stopPropagation() 完全沒有作用,
 * consumedKeys 也加得太晚,擋不住後續的 keyup。
 *
 * (這正是空白鍵還是會觸發 Spotify 播放/暫停的原因:
 *  空白鍵那條路徑上有 await persistSplits,方向鍵沒有,所以只有方向鍵正常。)
 *
 * 所以:攔截動作全部同步做完,存檔之類的非同步工作再放出去跑。
 */
function onRomajiKeydown(event) {
  const overlay = editingOverlay;
  if (!overlay) return;
  if (!EDIT_KEYS.has(event.key)) return; // 其他按鍵不攔,讓 Spotify 自己處理

  // ---- 以下三行必須在任何 await 之前 ----
  // 方向鍵會捲動頁面;空白鍵的播放/暫停是綁在 keyup,
  // 靠 consumedKeys 讓 onRomajiKeyEcho 把後續的 keypress/keyup 一起擋掉。
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
    case 'Spacebar': // 舊版 Edge/Firefox 的鍵名
      // 按著不放時不要連續切換,只認第一次
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
 * 擋掉「剛剛在編輯模式吃掉的那顆鍵」後續的 keypress / keyup。
 *
 * 這是空白鍵不再觸發播放/暫停的關鍵:Spotify 是在 keyup 才動作的。
 * 判斷條件只看 consumedKeys —— 沒進編輯模式就不會有東西被加進去,
 * 所以編輯模式關閉時空白鍵完全恢復正常,不會整個頁面被擋掉。
 */
function onRomajiKeyEcho(event) {
  const id = keyId(event);
  if (!consumedKeys.has(id)) return;

  // keydown → keypress → keyup,收到 keyup 才算這顆鍵處理完
  if (event.type === 'keyup') consumedKeys.delete(id);

  event.preventDefault();
  event.stopPropagation();
}

function registerSplitInteractions() {
  // 全部用捕獲階段委派在 document 上:
  // Spotify 會不斷重建歌詞行,掛在個別元素上的 listener 會跟著被丟掉;
  // 捕獲階段才能搶在 Spotify 自己的點擊/快捷鍵處理之前。
  document.addEventListener('mousedown', () => { pointerActive = true; }, true);
  document.addEventListener('mouseup', () => { pointerActive = false; }, true);
  document.addEventListener('click', onRomajiClick, true);
  document.addEventListener('focusin', onRomajiFocusIn, true);
  document.addEventListener('focusout', onRomajiFocusOut, true);
  document.addEventListener('keydown', onRomajiKeydown, true);
  document.addEventListener('keypress', onRomajiKeyEcho, true);
  document.addEventListener('keyup', onRomajiKeyEcho, true);

  // 按著鍵切到別的視窗時 keyup 會收不到,那顆鍵會卡在集合裡。
  // 回來時清掉,免得下一次按它被莫名其妙擋掉一次。
  window.addEventListener('blur', () => consumedKeys.clear());
}

/* ---------------------------------------------------------------- 佇列 */

/*
 * kuromoji 的斷詞是同步的 CPU 工作,一次丟 40 行進去會讓頁面卡住,
 * 所以還是一行一行做、每行之間讓出主執行緒。
 *
 * 但「順序」很重要:照 DOM 順序做的話,正在唱的那一行要排在它上面
 * 所有已經唱過的行後面 —— 那正是使用者看到的「拼音慢半拍」。
 * 所以改成用 Set + 每次挑最該做的那一行,而不是先進先出的鏈。
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

/** 讓出主執行緒。setTimeout(0) 實際上有 ~4ms 的下限,40 行就白白多花 160ms */
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
 * 每一輪都重新看「現在唱到哪」,所以播放推進時佇列會自動改變目標 ——
 * 這才是「正在播的那一行不用排隊」真正生效的地方。
 */
function pickNext() {
  const lines = currentLineElements();
  const active = lines.findIndex((el) => el.dataset.romajiActive === 'true');

  let best = null;
  let bestScore = Infinity;

  for (const el of pendingLines) {
    const index = lines.indexOf(el);
    let score;
    if (index < 0) score = 1e6; // 已經不在任何列表裡(元素被回收了)排最後
    else if (active < 0) score = index; // 判斷不出正在唱哪行就照原順序
    else if (index >= active) score = index - active; // 接下來要唱的,越近越優先
    else score = active - index + 1000; // 已經唱過的擺最後

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
      // 一次把整批的切分設定問完,而不是每行各問一次 IPC。
      // 只在有新行進來時才做,不然這個 while 每一輪都會白跑一次。
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
 * 兩種驅動方式,能用好的就用好的:
 *
 * A. LRC 時間軸(理想):知道每一句從第幾毫秒開始,配上播放進度就能算出
 *    「現在第幾句」以及「這句唱到幾成」。延遲趨近於零,而且做得出逐字掃過去。
 * B. 觀察 Spotify 畫面(退路):只知道現在是第幾句,而且是它更新完我們才知道,
 *    先天慢半拍。沒有 LRC、或 LRC 對不上這個版本時才用。
 */

/** 跟畫面上每一行一一對應的起始時間(毫秒);null 代表現在沒有可用的時間軸 */
let lineTimes = null;
/** 跟畫面上每一行一一對應的逐字進度折線;沒有逐字資料的行是 null */
let lineCurves = [];
/** 對齊時用的行數,行數變了就要重新對齊 */
let alignedCount = 0;
/** 已經跟 LRCLIB 要過的曲目,避免重複請求 */
let lrcAskedFor = null;
/** 這首歌的 LRC 原始內容(還沒對齊之前先放著) */
let pendingLrc = null;

function resetLrcState() {
  lineTimes = null;
  lineCurves = [];
  alignedCount = 0;
  pendingLrc = null;
  // 換歌時歌詞容器會被換掉,自動置中記著的舊容器與舊行都要一併丟掉
  resetAutoScroll();
}

/** 這一句唱到什麼時候結束(下一句開始)。最後一句沒有下一句就給個合理的長度。 */
function nextTimeAfter(index) {
  for (let i = index + 1; i < lineTimes.length; i += 1) {
    if (lineTimes[i] !== null) return lineTimes[i];
  }
  return lineTimes[index] + 4000;
}

/**
 * 向 service worker 要這首歌的歌詞,兩條路徑共用這一支。
 *
 * 為什麼一定要共用:曲目長度會**影響 service worker 挑哪個版本**
 * (同一首歌常有單曲版/專輯版/Live,長度差很多,時間軸完全不通用),
 * 而兩邊的快取又是同一格。先前這裡是兩處各自組裝訊息,
 * 只有 requestLrc 帶了長度、fallback 沒帶 —— 於是哪一條先跑,
 * 它挑的版本就佔住快取,另一條之後整整七天都拿到對不上的時間軸。
 *
 * 合成一支之後,「要問什麼」只寫一次,不可能再分岔。
 */
function askForLyrics(nowPlaying) {
  const durationMs = getDurationMs();
  return chrome.runtime.sendMessage({
    type: 'FETCH_LYRICS',
    ...nowPlaying,
    durationSec: durationMs ? Math.round(durationMs / 1000) : undefined,
  });
}

/** 向 service worker 要這首歌的時間軸 */
async function requestLrc(nowPlaying, key) {
  if (lrcAskedFor === key) return;
  lrcAskedFor = key;

  try {
    const res = await askForLyrics(nowPlaying);

    if (res?.timedOut) {
      lrcAskedFor = null; // 逾時不算問過,下次還能再試
      return;
    }
    if (!res?.synced) {
      console.info(`${LOG} LRCLIB 沒有這首歌的時間軸,高亮改用觀察畫面的方式`);
      return;
    }

    const parsed = parseLrc(res.synced);
    if (!parsed.lines.length) return;

    pendingLrc = parsed.lines;
    alignedCount = 0; // 逼下一輪重新對齊
  } catch (err) {
    console.warn(`${LOG} 取得時間軸失敗:`, err);
    lrcAskedFor = null;
  }
}

/**
 * 把 LRC 的句子對到畫面上的行。
 * 對得太差就整個放棄 —— 錯位的高亮比沒有高亮更糟。
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
    lineTimes = null;
    pendingLrc = null;
    return;
  }

  lineTimes = fillGaps(times);
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
 * 這兩個值都不是為了「估得更準」—— 只有句首時間的話那做不到。
 * 它們是為了讓估錯的時候不要錯得太離譜。
 */

/**
 * 掃描比實際句距略快一點收尾。
 *
 * 唱歌句中會有換氣、小停頓,真正的演唱時間比句距短,
 * 所以照句距等速掃會偏慢、整句唱完了還剩一截沒掃到。
 * 乘一個略小於 1 的係數,讓掃描剛好在下一句開始前收尾。
 */
const SWEEP_SPAN_FACTOR = 0.92;

/*
 * 「每個字母最多值得掃多少毫秒」搬到設定裡了(settings.sweepMsPerLetter),
 * 可以在 popup 一邊播一邊拖。
 *
 * 為什麼不寫死:合適的值取決於這首歌唱得多快,而那是每首歌都不一樣的。
 * 先前寫死 180 只是個猜測,而且要驗證它對不對非得盯著畫面看不可 ——
 * 與其我在這裡反覆猜,不如讓使用者當場調到看起來對為止。
 * 這跟 syncOffsetMs 是同一個判斷。
 */

/** 這一行的拼音有幾個字母 —— 拿來估「最多值得掃多久」 */
function countRomajiLetters(lineEl) {
  const overlay = lineEl.querySelector(':scope > .romaji-overlay');
  return overlay ? overlay.querySelectorAll('.romaji-ch').length : 0;
}

/**
 * 只更新「現在唱到哪一行、唱到哪個字」。
 * 這件事要比掃描頻繁得多:它同時決定了畫面上的高亮跟佇列的優先順序。
 */
function updateActiveLine() {
  if (!isEnabled()) return;

  const lines = [...document.querySelectorAll(LINE_SELECTOR)];

  // 沒有 Spotify 歌詞、但 LRCLIB 面板開著:高亮改由面板自己算。
  //
  // 面板不需要 alignLrc —— 那一步是為了「把 LRC 的句子對到畫面上的行」,
  // 而面板的行本來就是照 LRC 建出來的,一對一,沒有可能對錯。
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
  const position = raw + settings.syncOffsetMs;

  const active = activeIndexAt(lineTimes, position);

  /*
   * 逐字掃描的兩條路。
   *
   * 有逐字時間軸(enhanced LRC)時走 progressFromCurve —— 那是真資料,準。
   * 沒有的時候改用 progressAt 依句距估算。
   *
   * 這裡要講清楚:估算**先天無法準確**。只有句首時間的話,「唱得快」跟
   * 「唱得慢」的句子在資料上完全一樣,不管怎麼調參數都只能在兩種誤差之間
   * 換邊、不能消除。所以下面兩個參數的用途不是「讓它變準」(做不到),
   * 而是**把它出錯的幅度限制住**,讓掃描即使不精確也還能跟得上。
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
   * 這裡曾經有一個「掃描快慢」的倍率,做完就拿掉了 —— 詳見 settings.js
   * 的說明。簡單說:調快會讓字掃到底後停在句尾乾等,調慢會在唱完換行時
   * 被截斷。一句唱多久是歌本身決定的,掃描的正確行為只有一種。
   *
   * 要調整感受請用 syncOffsetMs,它讓整句與逐字**一起**平移。
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
   * 換句時自己把它捲到畫面中間,不等 Spotify。
   *
   * **只有走時間軸這條路才做。** 另一條路(下面的 markActive 退路)是靠
   * 觀察畫面判斷正在唱哪一行的,而其中一個策略就是「誰最靠近畫面中間」——
   * 在那條路上自動置中會變成自問自答:我們把某一行捲到中間,下一次判斷
   * 就因為它在中間而認定它正在被唱。有獨立的時間來源時才有資格插手捲動。
   */
  if (active >= 0) centerActiveLine(lines[active]);
}

/**
 * 現在要處理的是哪一組歌詞行。
 *
 * Spotify 自己有歌詞就用它的;完全沒有的時候(paywall、冷門曲目)
 * 才輪到 LRCLIB 面板。兩者不會同時存在 —— 面板本來就只在
 * 「等不到任何歌詞行」時才打開,而歌詞一旦出現 tick() 會把面板關掉。
 *
 * 抽成一個函式是為了讓佇列的優先順序邏輯不必知道歌詞從哪來:
 * 不管哪一種來源,「正在唱的那一行先轉」都是同一套規則。
 */
function currentLineElements() {
  const spotify = [...document.querySelectorAll(LINE_SELECTOR)];
  if (spotify.length) return spotify;
  return isLrcPanelOpen() ? getPanelLineElements() : [];
}

function scanNow() {
  if (!isEnabled()) return;
  const lines = currentLineElements();

  // 先確認現在唱到哪一行,pickNext 才有依據。
  //
  // 但有時間軸可用時**絕對不能**在這裡標記:那條路是由 updateActiveLine
  // 每 80ms 依播放進度寫 data-romaji-active,這裡每秒再用觀察畫面的方式
  // 寫一次同一個屬性,兩邊就會每秒打架一次 —— 畫面上看到的就是高亮在閃。
  // 面板的高亮是 updateLrcPanel 依 LRC 時間軸自己標的。
  // markActive 是去讀 Spotify 內層元素的樣式來判斷的,面板上沒有那些元素,
  // 讓它插手只會把面板已經標好的 data-romaji-active 清掉。
  if (!lineTimes && !isLrcPanelOpen()) markActive(lines);

  for (const lineEl of lines) {
    if (needsProcessing(lineEl)) enqueue(lineEl);
  }
}

/*
 * 有 leading edge 與上限等待時間的 debounce。
 *
 * 純 trailing debounce 在這裡會被餓死:observer 掛在 document.body 上,
 * 進度條、卡拉OK 逐字高亮這些東西變動得比 DEBOUNCE_MS 還頻繁,
 * 每一次都把計時器重置,結果可能永遠等不到掃描。
 *
 * lastScanAt  距離上次真的掃描夠久了 → 立刻掃(leading edge)
 * firstPendingAt  一直被重置但已經拖太久了 → 強制掃(maxWait)
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
 * 歌詞檢視是不是被打開了?
 *
 * 這是 fallback 判斷的關鍵。歌詞面板預設是關的,使用者要按歌詞鈕才會出現 ——
 * 「找不到 lyrics-container」絕大多數時候只代表「面板還沒打開」,
 * 不代表「這首歌沒有歌詞」。只有在使用者確實打開了歌詞檢視、
 * 卻等不到任何歌詞行時,才有資格去問 LRCLIB。
 */
function isLyricsViewOpen() {
  const button = document.querySelector(LYRICS_BUTTON_SELECTOR);
  if (button) {
    const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('data-active');
    if (pressed !== null) return pressed === 'true';
  }
  // 找不到按鈕(Spotify 改版)就退回看有沒有歌詞行
  return Boolean(document.querySelector(LINE_SELECTOR));
}

/**
 * 每秒跑一次的單一迴圈,取代原本「遞迴 setTimeout + 另一個 watchdog interval」的雙軌寫法。
 * emptyTicks 只在「歌詞檢視已打開但還沒有歌詞行」時累加,面板沒打開時會歸零。
 */
function tick() {
  // 擴充功能被重新載入之後這份 script 就沒有用了,再跑下去只會一直噴錯
  if (!isExtensionAlive()) {
    shutdown();
    return;
  }

  // 播放列被 React 重建時按鈕會被丟掉,每次都確認一次位置。
  // 即使目前是 'off' 也要維持這顆按鈕,否則使用者沒辦法從頁面上開回來。
  syncToggleButton(() => settings.displayMode, cycleDisplayMode);

  // 換歌時舊的時間軸完全沒有意義,要整組丟掉重來
  const nowPlaying = readNowPlaying();
  const trackKey = nowPlaying ? `${nowPlaying.trackName}|${nowPlaying.artistName}` : null;
  if (trackKey !== currentTrackKey) {
    currentTrackKey = trackKey;
    resetLrcState();
    lrcAskedFor = null;
    emptyTicks = 0;
    fallbackAskedFor = null;
    panelDismissedFor = null; // 上一首關掉了不代表這一首也不想看
    closeLrcPanel();
    // 修正面板是綁在某一句上的,換歌之後那一句已經不在畫面上了
    closeCorrectionPopover();
  }

  // React 換頁時有整批清理的動作,面板掉了要補回去
  ensurePanelAttached();
  // 有歌詞在畫面上才需要時間軸(沒歌詞的歌走的是另一條 LRCLIB fallback)
  if (trackKey && nowPlaying && document.querySelector(LINE_SELECTOR)) {
    requestLrc(nowPlaying, trackKey);
  }

  // 每秒無條件掃一次當安全網。
  // 一定要用 scanNow 而不是 scanSoon —— 會被 debounce 的安全網不算安全網。
  // observer 若因為任何原因漏接(記錄被過濾掉、React 用了沒被觀察到的手法),
  // 最壞情況也只是慢一秒,不會永遠不更新。
  scanNow();

  const lineCount = document.querySelectorAll(LINE_SELECTOR).length;

  if (lineCount > 0) {
    emptyTicks = 0; // 有歌詞,一切正常
    // Spotify 的歌詞後來才載進來(先前只是慢或還在載),就把面板收掉 ——
    // 兩份歌詞同時擺在畫面上只會互相干擾,而且 Spotify 那份跟畫面是同步的
    if (isLrcPanelOpen()) {
      console.info(`${LOG} Spotify 的歌詞出現了,收起 LRCLIB 面板`);
      closeLrcPanel();
    }
  } else if (isLyricsViewOpen()) {
    emptyTicks += 1; // 面板開著卻是空的 —— 可能 paywall、沒歌詞,或還在載入
    if (emptyTicks === FALLBACK_AFTER_TICKS) tryLrclibFallback();
  } else {
    emptyTicks = 0; // 面板根本沒打開,不能下任何結論

    /*
     * 使用者把歌詞檢視關掉了,我們的面板也該跟著收 ——
     * 他要的是「現在不想看歌詞」,不是「不想看 Spotify 的歌詞」。
     *
     * 但這裡刻意只認**明確的否定**:isLyricsViewOpen 找不到歌詞按鈕時
     * 會退回去看畫面上有沒有歌詞行,而面板開著的時候那個判斷一定是 false。
     * 直接信它的話,在找不到按鈕的 Spotify 版本上,面板會在開啟的下一秒
     * 就自己關掉 —— 使用者只會看到它閃一下。
     */
    if (isLrcPanelOpen() && lyricsViewExplicitlyClosed()) closeLrcPanel();
  }
}

/**
 * 歌詞檢視**確定**是關著的嗎?
 *
 * 跟 isLyricsViewOpen() 的差別在於「不知道」的處理方式:那一支在找不到
 * 按鈕時會用歌詞行數去猜,這一支則回 false(不確定就當作沒關)。
 * 因為這裡要做的是關掉面板 —— 猜錯的代價是把使用者正在看的東西弄不見。
 */
function lyricsViewExplicitlyClosed() {
  const button = document.querySelector(LYRICS_BUTTON_SELECTOR);
  if (!button) return false;
  const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('data-active');
  return pressed === 'false';
}

/**
 * 歌詞行沒有共同、帶專屬 data-testid 的祖先容器可以掛 observer,
 * 所以改掛在 document.body 上一次就好,不用再隨容器換掉而重掛。
 */
/** 我們自己插進頁面的元素。從這些元素來的變動不該再觸發掃描 */
const OWN_ELEMENTS = '.romaji-overlay, .romaji-original, .romaji-toggle, .romaji-lrc-panel';

/**
 * 這筆變動是我們自己造成的嗎?
 *
 * 為什麼要濾:observer 掛在 document.body 上,而我們自己每插一個 overlay、
 * 每重繪一次拼音(使用者每點一下切分都會重繪)都會產生 childList 記錄,
 * 那些記錄又會把 debounce 的計時器重置 —— 自己餵自己,永遠掃不到。
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
 * 擴充功能被重新載入(或停用、更新)之後,已經開著的分頁裡這份 script
 * 會變成孤兒:程式還在跑,但 chrome.* API 全部失效。
 *
 * 不處理的話,每秒的 tick 與 80ms 的高亮迴圈會一直去碰 chrome.storage,
 * console 就被 "Extension context invalidated" 洗版。
 * 偵測到就把自己收掉,安靜等使用者重新整理頁面。
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
  closeCorrectionPopover();
  // 面板留在畫面上但已經沒有東西在更新它了,那比沒有面板更誤導
  closeLrcPanel();
  console.info(`${LOG} 擴充功能已重新載入,此分頁的舊實例停止運作(重新整理頁面即可恢復)`);
}

function startWatching() {
  observer = new MutationObserver((records) => {
    // ensureOriginalWrapper 搬的是 React 自己的節點,靠 isOwnRecord 認不出來,
    // 所以那段期間直接整批略過。這樣做安全的前提是 tick() 每秒
    // 無條件 scanNow() —— 萬一真的漏掉一筆,最多慢一秒。
    if (selfMutating > 0) return;
    if (records.every(isOwnRecord)) return;
    scanSoon();
  });

  // characterData 不能省:把原文包進 .romaji-original 之後,那個文字節點
  // 就固定不動了,React 換句子時是直接改 nodeValue —— 這不會發出
  // childList 記錄,只發 characterData。少了它就完全收不到換句子的通知。
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // 高亮要另外用比較快的節奏更新。
  // 掛在 tick(1 秒)上的話,平均會慢半秒才換行 —— 跟唱時很明顯。
  // 這個迴圈只做標記,不做轉換,很便宜(而且 findActiveIndex 內部還有快取)。
  timers.push(setInterval(updateActiveLine, ACTIVE_TICK_MS));

  tick();
  timers.push(setInterval(tick, TICK_MS));
}

/* ------------------------------------------------- LRCLIB fallback(僅 API) */

/** 從播放列讀出目前曲目資訊。Spotify 改版過幾次,所以列了幾個備援選擇器。 */
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
 * 歌詞檢視開著、但等了 FALLBACK_AFTER_TICKS 秒仍然一行都沒有時
 * (paywall 或該曲真的沒歌詞),改問 service worker 去 LRCLIB 查,
 * 查到就開一個自己的浮動面板把歌詞顯示出來。
 *
 * ── 這個 fallback 的適用範圍 ──────────────────────────────
 * 觸發條件是「面板開著卻等不到任何歌詞行」,所以它處理的是
 * **Spotify 根本沒有這首歌的歌詞**。它不是「換一個歌詞來源」——
 * Spotify 有歌詞的時候這裡永遠不會被呼叫到。
 * 若之後想改成優先用 LRCLIB,要動的是 tick() 裡的觸發條件,不是這裡。
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
    // 一定要走 askForLyrics —— 這裡若自己組裝訊息就會漏掉曲目長度,
    // 而長度決定了 service worker 挑哪個版本(見 askForLyrics 的說明)
    const res = await askForLyrics(nowPlaying);
    if (res?.timedOut) {
      console.warn(`${LOG} LRCLIB 查詢逾時,稍後換歌時會再試`);
      fallbackAskedFor = null; // 逾時不算問過,允許重試
      return;
    }
    if (!res?.lines?.length && !res?.synced) {
      console.info(`${LOG} LRCLIB 也沒有這首歌的歌詞`);
      return;
    }

    // 這段 await 期間使用者可能已經換歌、關掉歌詞檢視,或 Spotify 的歌詞
    // 終於載進來了。任何一種情況下開面板都是錯的。
    if (key !== currentTrackKey || panelDismissedFor === key) return;
    if (document.querySelector(LINE_SELECTOR)) return;

    // 有時間軸就用時間軸(才做得出高亮與逐字掃描),沒有就退回純文字
    const timed = res.synced ? parseLrc(res.synced).lines : null;

    const lineEls = openLrcPanel({
      title: nowPlaying.trackName,
      subtitle: `${nowPlaying.artistName} · 歌詞來自 LRCLIB${res.cached ? '(快取)' : ''}`,
      timed: timed?.length ? timed : null,
      plain: res.lines ?? null,
      onClose: () => {
        // 記住他關掉了,不要下一秒又自己彈回來
        panelDismissedFor = key;
      },
    });

    // 面板的行走的是跟 Spotify 歌詞完全相同的轉換流程,
    // 所以這裡只要把它們丟進同一個佇列就好,不必另外寫一套。
    for (const el of lineEls) enqueue(el);
  } catch (err) {
    console.warn(`${LOG} 呼叫 service worker 失敗:`, err);
  }
}

/* ------------------------------------------------------------------ 啟動 */

async function main() {
  settings = await getSettings();
  applySettings();

  // 不等歌詞面板打開就先讓 kuroshiro 開始載辭典(README 限制 #2)
  ready.catch(() => {});

  registerSplitInteractions();

  /*
   * 使用者新增/刪除自訂讀音之後,畫面要立刻反映出來。
   *
   * 三件事缺一不可:清掉轉換結果的快取、把所有行的處理旗標拿掉、重新掃描。
   * 少了第一項會拿到舊的轉換結果;少了第二項 needsProcessing 會判定
   * 「這行已經處理過了」而不重轉。
   *
   * 已存的手動切分不用管 —— splitter.js 用 letters 當校驗碼,讀音變了
   * 就對不上、自動作廢,不會把空格插到錯的位置。
   */
  /*
   * 去要一份大家共用的字典。
   *
   * 刻意**不等它** —— 抓字典要連網,而使用者已經在看歌詞了。
   * 讓轉換先用內建的跑起來,字典回來之後若真的有變動,
   * 上面那個訂閱會收到通知並重轉一次。
   *
   * 抓不到就抓不到:內建那份還在,只是少了新收的詞。
   */
  loadSharedDictionary().catch(() => {});

  onCorrectionsChanged(() => {
    invalidateRomajiCache();
    reconvertEverything();
  });

  // 高亮要靠播放進度驅動,時鐘必須一開始就跑起來
  startClock();

  startWatching();
}

main();
