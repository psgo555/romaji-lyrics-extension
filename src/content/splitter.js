/**
 * splitter.js
 * 手動切分羅馬拼音。
 *
 * kuromoji 依詞彙邊界斷詞,長動詞(例如「透き通った」→ sukitootta)會整體黏為
 * 一個詞、內部沒有空格,跟唱時不易閱讀。本模組讓使用者自行插入或取消空格,
 * 並保存結果。
 *
 * 資料模型:
 *
 *   letters    移除所有空格後的純字母序列,例如 "sukitootta"
 *   boundaries 一組整數,表示第 i 個字母前方應有空格
 *
 * 拆為兩者而非直接儲存含空格的字串,是因為使用者的意圖在於「切分的位置」。
 * letters 另存一份作為校驗碼:修正字典或 kuroshiro 使讀音變動、letters 對不上時,
 * 即將舊的切分視為過期而忽略,避免將空格插入錯誤的位置。
 *
 * 儲存位置為 chrome.storage.local,僅保留於使用者自身的瀏覽器。
 */

import { stripMacrons } from './macron.js';

const KEY_PREFIX = 'split:';
const CHAR_CLASS = 'romaji-ch';

/** 記憶體快取,避免同一句歌詞每次重繪皆讀取一次 storage */
const memoryCache = new Map();

/**
 * 將 kuroshiro 的輸出拆為 letters 與預設 boundaries。
 * 連續多個空格(kuroshiro 偶爾會輸出)僅計為一個切分點。
 * @param {string} romaji
 * @returns {{ letters: string, boundaries: Set<number> }}
 */
export function splitRomaji(romaji) {
  const letters = [];
  const boundaries = new Set();

  for (const char of romaji) {
    if (/\s/.test(char)) {
      // 開頭的空白不計為切分點,否則會產生無意義的前導空格
      if (letters.length > 0) boundaries.add(letters.length);
    } else {
      letters.push(char);
    }
  }

  return { letters: letters.join(''), boundaries };
}

/**
 * 將 letters 與 boundaries 繪製為一串可點擊的 <span>。
 * 空格置於字母前方,一併作為該 span 的內容,瀏覽器因而仍可在空格處自然換行
 * (改用獨立的間隔元素則無法達成)。
 */
export function renderRomaji(overlayEl, letters, boundaries, caret = null, unknownRanges) {
  // 未傳入第五個參數時沿用先前保存的值。
  //
  // setCaret、moveCaret 與 toggleBoundary 皆會再次呼叫本函式,但它們不知道、
  // 也不需要知道哪些字未轉出。將其存入 dataset 再讀回,這三個既有呼叫端
  // 無須修改,按方向鍵亦不會遺失標記。
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
    // 游標繪於第 i 個字母的左緣,即切點本身的位置
    if (caret === i) span.dataset.caret = 'true';

    const range = ranges.find((r) => i >= r.start && i < r.end);
    if (range) {
      span.dataset.romajiUnknown = '1';
      span.dataset.romajiSurface = range.text; // 點擊後要修正的詞
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

/** 自畫面讀回目前的切分狀態。DOM 即為唯一的真相來源,不另存副本。 */
export function readBoundaries(overlayEl) {
  const boundaries = new Set();
  for (const span of overlayEl.querySelectorAll(`.${CHAR_CLASS}`)) {
    if (span.textContent.startsWith(' ')) boundaries.add(Number(span.dataset.index));
  }
  return boundaries;
}

/* ------------------------------------------------------------ 游標與切換 */

/**
 * 將游標位置夾至有效範圍。
 * 有效切點為 1 至 letters.length-1(切於整串的最前或最後沒有意義),
 * 與 boundaryFromClick 採用同一套位置系統,滑鼠與鍵盤因而指涉同一件事。
 * @returns {number|null} 字母數不足 2 時無處可切,回 null
 */
export function clampCaret(caret, lettersLength) {
  if (lettersLength < 2) return null;
  return Math.min(Math.max(caret, 1), lettersLength - 1);
}

/** 讀出目前的游標位置,不在編輯模式(無游標)時回 null */
export function getCaret(overlayEl) {
  const raw = overlayEl.dataset.romajiCaret;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** 移動游標並重繪,切分狀態不變。傳入 null 表示離開編輯模式、收起游標。 */
export function setCaret(overlayEl, caret) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const next = caret == null ? null : clampCaret(caret, letters.length);

  /*
   * 僅移動游標,不重建節點。
   *
   * 原先此處為整排重繪。移動游標本身看不出差異,但重繪會替換節點,
   * 因而連帶破壞兩件與游標無關的事:
   *
   *   1. 使用者以滑鼠拖出的文字選取會立即消失
   *   2. 雙擊無法觸發 —— 雙擊的事件序列為 click → click → dblclick,
   *      第一下之後節點即被替換,第二下落在新的元素上,瀏覽器無法算出兩者的
   *      共同目標,dblclick 因而不會派送。實測症狀為雙擊完全沒有反應。
   *
   * 字母數未變時沒有理由重繪,移動一個屬性即足夠。
   */
  const spans = overlayEl.querySelectorAll(`.${CHAR_CLASS}`);
  if (spans.length === letters.length) {
    spans.forEach((span, i) => {
      if (i === next) span.dataset.caret = 'true';
      else if (span.dataset.caret) delete span.dataset.caret;
    });
    overlayEl.dataset.romajiCaret = next == null ? '' : String(next);
    return next;
  }

  // 節點數不符(尚未 render 過,或內容剛被替換)時才整體重繪
  renderRomaji(overlayEl, letters, readBoundaries(overlayEl), next);
  return next;
}

/** 游標相對移動,例如 moveCaret(el, -1) 為向左一格 */
export function moveCaret(overlayEl, delta) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const current = getCaret(overlayEl) ?? clampCaret(1, letters.length);
  if (current == null) return null;
  return setCaret(overlayEl, current + delta);
}

/**
 * 切換指定切點的空格。滑鼠點擊與鍵盤空白鍵共用本函式,
 * 不分開實作,否則兩者的行為終將產生分歧。
 * @returns {Set<number>} 切換後的切分點
 */
export function toggleBoundary(overlayEl, boundary) {
  const letters = overlayEl.dataset.romajiLetters ?? '';
  const boundaries = readBoundaries(overlayEl); // 必須於重繪之前讀取

  if (boundaries.has(boundary)) boundaries.delete(boundary);
  else boundaries.add(boundary);

  renderRomaji(overlayEl, letters, boundaries, getCaret(overlayEl));
  return boundaries;
}

/**
 * 判定該次點擊落於哪兩個字母之間。
 * 點於某字母的左半 → 切於其前方;右半 → 切於其後方。
 * @returns {number|null} 切分點索引;點於首尾等無效位置時回 null
 */
export function boundaryFromClick(event, lettersLength) {
  const span = event.target?.closest?.(`.${CHAR_CLASS}`);
  if (!span) return null;

  const index = Number(span.dataset.index);
  if (!Number.isInteger(index)) return null;

  const rect = span.getBoundingClientRect();
  const onLeftHalf = event.clientX - rect.left < rect.width / 2;
  const boundary = onLeftHalf ? index : index + 1;

  // 切於整串的最前或最後沒有意義
  if (boundary < 1 || boundary > lettersLength - 1) return null;
  return boundary;
}

/**
 * 一次將多句歌詞的切分讀入記憶體快取。
 *
 * loadSplits 為一句一次 chrome.storage.local.get,而該操作屬跨行程 IPC。
 * 剛開啟歌詞面板時有 40 句待處理,即形成 40 次往返,且夾在 40 次斷詞之間交替
 * 進行,拼音因而延遲出現。此處改為一次查詢整批。
 *
 * loadSplits 本身無須修改:預載完成後它一律命中 memoryCache 直接返回。
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
    // 記為「已查詢,無資料」,否則每一輪都會再次嘗試,失敗時形成重試風暴
    for (const source of missing) memoryCache.set(source, null);
  }
}

/**
 * 將保存的條目與目前算出的 letters 對照,判定是否可用。
 *
 * 對不上即表示讀音已變動(修正字典經過修改,或 kuroshiro 換版),此時舊的切點
 * 會落於錯誤的位置,寧可捨棄亦不插入錯誤位置。
 *
 * 但對不上亦可能是誤判,而誤判會使使用者的切分無故消失。因此此處將兩邊的值
 * 一併輸出,可直接判斷是讀音確實變動,或是判斷本身有問題。
 */
function acceptEntry(entry, letters, source) {
  if (!entry) return null;
  if (entry.letters === letters) return new Set(entry.boundaries);

  // 舊資料含長音符(ō ē),為「移除長音符」這項改動之前保存的內容。
  //
  // 該情況並非讀音變動,而是同一讀音的另一種寫法,切點完全沒有位移。
  // 逕行判定為過期會使所有含長音的句子的切分一併消失。
  //
  // 可安心沿用的依據:stripMacrons 不改變字串長度,而 boundaries 保存的是
  // 字母索引 —— 長度不變,索引即仍指向原處。
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

/**
 * 讀取某句歌詞先前保存的切分。
 * @param {string} source 原始日文歌詞行,作為索引
 * @param {string} letters 目前算出的字母序列,用於確認舊資料未過期
 * @returns {Promise<Set<number>|null>} 未保存過或已過期時回 null
 */
export async function loadSplits(source, letters) {
  if (memoryCache.has(source)) {
    // 快取中的內容同樣須與目前的 letters 相符
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

/** 保存某句歌詞的切分 */
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
