/**
 * splitter.js
 * 手動切分羅馬拼音。
 *
 * kuromoji 是照「詞彙邊界」斷詞,長動詞(例如「透き通った」→ sukitootta)
 * 會整個黏成一個詞、內部沒有空格,跟唱時很難讀。
 * 這個模組讓使用者點一下拼音就自己插入/取消空格,並把結果記起來。
 *
 * 資料模型:
 *   letters    把所有空格拿掉之後的純字母序列,例如 "sukitootta"
 *   boundaries 一組整數,代表「第 i 個字母前面要有空格」
 *
 * 之所以拆成這兩者而不是直接存加好空格的字串,是因為
 * 「切在哪裡」才是使用者的意圖;letters 另外存一份當校驗碼,
 * 之後如果修正字典或 kuroshiro 讓讀音變了、letters 對不上,
 * 就把舊的切分視為過期直接忽略,不會把空格插到錯的位置。
 *
 * 儲存位置是 chrome.storage.local(只留在使用者自己的瀏覽器)。
 */

import { stripMacrons } from './macron.js';

const KEY_PREFIX = 'split:';
const CHAR_CLASS = 'romaji-ch';

/** 記憶體快取,避免同一句歌詞每次重繪都去讀一次 storage */
const memoryCache = new Map();

/**
 * 把 kuroshiro 的輸出拆成 letters + 預設 boundaries。
 * 連續多個空格(kuroshiro 偶爾會吐出來)只算一個切分點。
 * @param {string} romaji
 * @returns {{ letters: string, boundaries: Set<number> }}
 */
export function splitRomaji(romaji) {
  const letters = [];
  const boundaries = new Set();

  for (const char of romaji) {
    if (/\s/.test(char)) {
      // 開頭的空白不算切分點(不然會多一個沒意義的前導空格)
      if (letters.length > 0) boundaries.add(letters.length);
    } else {
      letters.push(char);
    }
  }

  return { letters: letters.join(''), boundaries };
}

/**
 * 把 letters + boundaries 畫成一串可點擊的 <span>。
 * 空格放在字母的前面一起當作該 span 的內容,
 * 這樣瀏覽器仍然可以在空格處自然換行(用單獨的間隔元素就做不到)。
 */
export function renderRomaji(overlayEl, letters, boundaries, caret = null, unknownRanges) {
  // 沒傳第五個參數就沿用上次存的。
  //
  // 這一點很重要:setCaret / moveCaret / toggleBoundary 都會重新呼叫這個函式,
  // 但它們不知道、也不該知道「哪些字沒轉出來」。存進 dataset 再讀回來,
  // 那三個既有呼叫端就一行都不用改,按方向鍵也不會把標記弄丟。
  if (unknownRanges) {
    overlayEl.dataset.romajiUnknown = JSON.stringify(unknownRanges);
  }
  const ranges = unknownRanges ?? safeParseRanges(overlayEl.dataset.romajiUnknown);

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < letters.length; i += 1) {
    const span = document.createElement('span');
    span.className = CHAR_CLASS;
    span.dataset.index = String(i);
    span.textContent = (boundaries.has(i) ? ' ' : '') + letters[i];
    // 游標畫在「第 i 個字母的左緣」,也就是切點本身的位置
    if (caret === i) span.dataset.caret = 'true';

    const range = ranges.find((r) => i >= r.start && i < r.end);
    if (range) {
      span.dataset.romajiUnknown = '1';
      span.dataset.romajiSurface = range.text; // 點下去要修的是哪個詞
    }

    fragment.appendChild(span);
  }

  overlayEl.replaceChildren(fragment);
  overlayEl.dataset.romajiLetters = letters;
  overlayEl.dataset.romajiCaret = caret == null ? '' : String(caret);
}

function safeParseRanges(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 從畫面上讀回目前的切分狀態 —— DOM 就是唯一的真相來源,不另外存一份 */
export function readBoundaries(overlayEl) {
  const boundaries = new Set();
  for (const span of overlayEl.querySelectorAll(`.${CHAR_CLASS}`)) {
    if (span.textContent.startsWith(' ')) boundaries.add(Number(span.dataset.index));
  }
  return boundaries;
}

/* ------------------------------------------------------------ 游標與切換 */

/**
 * 把游標位置夾在有效範圍內。
 * 有效切點是 1 ~ letters.length-1(切在整串的最前或最後沒有意義),
 * 跟 boundaryFromClick 用的是同一套位置系統,所以滑鼠與鍵盤談的是同一件事。
 * @returns {number|null} 字母數不足 2 時無處可切,回 null
 */
export function clampCaret(caret, lettersLength) {
  if (lettersLength < 2) return null;
  return Math.min(Math.max(caret, 1), lettersLength - 1);
}

/** 讀出目前游標位置,沒有游標(不在編輯模式)時回 null */
export function getCaret(overlayEl) {
  const raw = overlayEl.dataset.romajiCaret;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** 移動游標並重繪(切分狀態不變)。傳 null 代表離開編輯模式、收起游標。 */
export function setCaret(overlayEl, caret) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const next = caret == null ? null : clampCaret(caret, letters.length);
  renderRomaji(overlayEl, letters, readBoundaries(overlayEl), next);
  return next;
}

/** 游標相對移動,例如 moveCaret(el, -1) 往左一格 */
export function moveCaret(overlayEl, delta) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const current = getCaret(overlayEl) ?? clampCaret(1, letters.length);
  if (current == null) return null;
  return setCaret(overlayEl, current + delta);
}

/**
 * 切換某個切點的空格 —— 滑鼠點擊與鍵盤空白鍵共用這一個函式,
 * 不要各寫一套,否則兩邊的行為遲早會走鐘。
 * @returns {Set<number>} 切換後的切分點
 */
export function toggleBoundary(overlayEl, boundary) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const boundaries = readBoundaries(overlayEl); // 一定要在重繪之前讀

  if (boundaries.has(boundary)) boundaries.delete(boundary);
  else boundaries.add(boundary);

  renderRomaji(overlayEl, letters, boundaries, getCaret(overlayEl));
  return boundaries;
}

/**
 * 判斷這一下點在哪兩個字母之間。
 * 點在某個字母的左半邊 → 切在它前面;右半邊 → 切在它後面。
 * @returns {number|null} 切分點索引,點在頭尾等無效位置時回 null
 */
export function boundaryFromClick(event, lettersLength) {
  const span = event.target?.closest?.(`.${CHAR_CLASS}`);
  if (!span) return null;

  const index = Number(span.dataset.index);
  if (!Number.isInteger(index)) return null;

  const rect = span.getBoundingClientRect();
  const onLeftHalf = event.clientX - rect.left < rect.width / 2;
  const boundary = onLeftHalf ? index : index + 1;

  // 切在整串的最前面或最後面沒有意義
  if (boundary < 1 || boundary > lettersLength - 1) return null;
  return boundary;
}

/**
 * 一次把多句歌詞的切分讀進記憶體快取。
 *
 * 為什麼要有這個:loadSplits 是一句一次 chrome.storage.local.get,
 * 而那是跨行程的 IPC。剛打開歌詞面板時有 40 句要處理,就變成 40 次來回,
 * 而且是夾在 40 次斷詞之間輪流做 —— 拼音會慢半拍才出現。
 * 這裡改成一次把整批問完。
 *
 * loadSplits 本身完全不用改:預載之後它一律命中 memoryCache 直接返回。
 *
 * @param {string[]} sources 原始日文歌詞行
 */
export async function preloadSplits(sources) {
  const missing = [...new Set(sources)].filter((s) => s && !memoryCache.has(s));
  if (!missing.length) return;

  try {
    const stored = await chrome.storage.local.get(missing.map((s) => KEY_PREFIX + s));
    for (const source of missing) {
      memoryCache.set(source, stored[KEY_PREFIX + source] ?? null);
    }
  } catch (err) {
    console.warn('[romaji] 批次讀取切分設定失敗:', err);
    // 記成「查過了,沒有」,否則每一輪都會再試一次,失敗時變成重試風暴
    for (const source of missing) memoryCache.set(source, null);
  }
}

/**
 * 讀取某句歌詞先前存好的切分。
 * @param {string} source 原始日文歌詞行(當索引用)
 * @param {string} letters 目前算出來的字母序列,用來確認舊資料沒過期
 * @returns {Promise<Set<number>|null>} 沒存過或已過期時回 null
 */
/**
 * 把存下來的那筆跟目前算出來的 letters 對照,決定能不能用。
 *
 * 對不上就代表讀音變了(改了修正字典、或 kuroshiro 換了版本),
 * 這時舊的切點會落在錯的位置,寧可丟掉也不要插錯。
 *
 * 但「對不上」也可能是誤判 —— 那會讓使用者覺得切分莫名其妙消失。
 * 所以這裡把兩邊的值都印出來,一眼就能看出是真的變了還是判斷有問題。
 */
function acceptEntry(entry, letters, source) {
  if (!entry) return null;
  if (entry.letters === letters) return new Set(entry.boundaries);

  // 舊資料含長音符(ō ē) —— 那是「移除長音符」這個改動之前存的。
  //
  // 這不是讀音變了,是同一個讀音的另一種寫法,切點完全沒有移動,
  // 直接判過期會害使用者的切分整批消失(所有含長音的句子都會中)。
  //
  // 之所以能安心沿用:stripMacrons 不改變字串長度,
  // 而 boundaries 存的是字母索引 —— 長度不變,索引就還指在原處。
  if (stripMacrons(entry.letters) === letters) return new Set(entry.boundaries);

  console.warn(
    '[romaji] 切分過期被忽略(存的讀音跟現在算出來的對不上):',
    JSON.stringify(source),
    '\n  存的:',
    JSON.stringify(entry.letters),
    '\n  現在:',
    JSON.stringify(letters)
  );
  return null;
}

export async function loadSplits(source, letters) {
  if (memoryCache.has(source)) {
    // 快取裡的也要對得上目前的 letters
    return acceptEntry(memoryCache.get(source), letters, source);
  }

  try {
    const key = KEY_PREFIX + source;
    const stored = await chrome.storage.local.get(key);
    const entry = stored[key] ?? null;
    memoryCache.set(source, entry);
    return acceptEntry(entry, letters, source);
  } catch (err) {
    console.warn('[romaji] 讀取切分設定失敗:', err);
    return null;
  }
}

/** 存下某句歌詞的切分 */
export async function saveSplits(source, letters, boundaries) {
  const entry = {
    letters,
    boundaries: [...boundaries].sort((a, b) => a - b),
  };
  memoryCache.set(source, entry);

  try {
    await chrome.storage.local.set({ [KEY_PREFIX + source]: entry });
  } catch (err) {
    console.warn('[romaji] 儲存切分設定失敗:', err);
  }
}
