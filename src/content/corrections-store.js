/**
 * corrections-store.js
 * 使用者自訂讀音的儲存層。
 *
 * 必要性:kuromoji 的內建辭典(IPADIC)必然存在讀不出來或讀錯的詞 ——
 * 罕用漢字、專有名詞、歌詞中的特殊寫法。每遇到一個便修改程式碼重新 build
 * 過於緩慢,故讓使用者直接在畫面上補上,存入瀏覽器後立即生效,之後所有歌曲通用。
 *
 * 職責分工:
 * - corrections.js  純邏輯,不觸及 chrome API(Node 測試直接匯入它)
 * - 本模組          負責讀寫 chrome.storage,並將合併後的表灌回
 */

import {
  CORRECTIONS as BUILTIN,
  setActiveCorrections,
  applyCorrectionsWith,
  sortCorrections,
} from './corrections.js';

const LOG = '[romaji]';
const KEY = 'userCorrections';
const VERSION = 1;

/*
 * chrome.storage.sync 的限制:單一項目 8192 bytes、總計 102400 bytes。
 * 超過即整筆寫入失敗,且不太會有明顯的錯誤 —— 使用者只會覺得「存不進去」。
 * 故寫入前先行測量,保留餘裕即攔下並明確告知。
 */
const QUOTA_BYTES = 7000;

/** 目前的使用者修正 { 原文: 讀音 } */
let entries = {};
const listeners = new Set();

/*
 * 讀音的驗證已移至 reading.js —— 與「將輸入轉為假名」置於一處,
 * 那兩件事是同一個問題的兩面,分開放置時放寬其中一邊便會對不上。
 * 另一個原因:本檔案含有 module-level 的 chrome 呼叫、Node 測不到,
 * 而讀音驗證正是最需要測試的部分。
 *
 * 注意此處是兩行,不是一行。
 *
 * `export { x } from './y.js'` 僅是將 x 轉給其他模組使用,不會在本檔案中
 * 建立一個名為 x 的名字。下方 addUserCorrection 自身要呼叫 isValidReading,
 * 因此還需要一個真正的 import。
 *
 * 缺少 import 那一行的症狀:打包不報錯、載入亦不報錯,直到使用者
 * 真正按下儲存才拋出 ReferenceError —— 而畫面上只會顯示「存不了」。
 * (那正是它上線的方式,並非假設。)
 */
import { isValidReading } from './reading.js';
export { READING_PATTERN, isValidReading } from './reading.js';

// 曲名的正規化必須與驗證那一支共用同一份 —— 各寫一份的話,
// 字典收錄的曲名與此處查詢的曲名會在空白或大小寫上無聲地對不上。
import { normalizeSongTitle } from '../shared/shared-dictionary.js';

/** 共用的那一份(自 GitHub 取得),尚未取得前為空 */
let shared = [];

/**
 * 共用字典中限定單曲的條目,{ 正規化曲名: [{surface, reading}] }。
 *
 * 需要這一層的原因:回報者無從判斷一筆修正在其他歌曲中是否安全。
 * 「失 → な」在某首歌是正確的,全域生效卻會使失敗變成なはい。
 * 綁在一首歌上則毋須判斷 —— 即使錯誤亦僅錯那一首,而同一首歌的其他使用者
 * 可直接取得修正後的結果,不必逐一再修一次。
 */
let sharedSongs = {};

/** 目前播放中的曲目(已正規化的曲名) */
let currentSong = '';

function songEntries(title) {
  return sharedSongs[title] ?? [];
}

/**
 * 將四層合成一份生效清單。
 *
 * 優先順序:使用者自訂 > 這首歌專屬 > 共用通用 > 內建
 *
 * 這首歌專屬排在通用之前,是因為它更為具體:有人特地為這首歌回報,
 * 即代表通用那一筆在這首歌中不正確(或根本沒有)。具體的規則本就應蓋過概括的。
 *
 * 使用者最優先的原因:他看得到自己那首歌的實際結果,而共用字典是為
 * 「多數情況」收錄的。萬一某個詞在他所聽的歌中是另一種讀法,
 * 他修改後卻被共用的覆蓋回去,該功能等同失效。
 *
 * 共用排在內建之前的原因:內建那份隨擴充功能發布,更新須等新版;
 * 共用那份修改後數小時內即可送達。同一個詞兩邊皆有時,新的那份較可能是修好的。
 */
function merge() {
  const song = songEntries(currentSong);

  const userSurfaces = new Set(Object.keys(entries));
  const songSurfaces = new Set(song.map((s) => s.surface));
  const sharedSurfaces = new Set(shared.map((s) => s.surface));

  const taken = (surface) => userSurfaces.has(surface) || songSurfaces.has(surface);

  const list = [
    ...BUILTIN.filter((b) => !taken(b.surface) && !sharedSurfaces.has(b.surface)),
    ...shared.filter((s) => !taken(s.surface)),
    ...song.filter((s) => !userSurfaces.has(s.surface)),
    ...Object.entries(entries).map(([surface, reading]) => ({ surface, reading })),
  ];
  setActiveCorrections(list);
  return list;
}

/**
 * 索取一份共用字典並套用。取不到則維持現狀,不予清空。
 *
 * 呼叫端取得 true 代表清單確實變動 —— 屆時才需要重新轉換畫面上的歌詞,
 * 未變動時重轉只會讓頁面白白卡頓一下。
 *
 * @returns {Promise<boolean>} 生效清單是否有變動
 */
export async function loadSharedDictionary() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'FETCH_DICTIONARY' });
    const next = Array.isArray(res?.entries) ? res.entries : [];
    const nextSongs = res?.songs && typeof res.songs === 'object' ? res.songs : {};
    if (!next.length && !Object.keys(nextSongs).length) return false;

    // 內容相同即毋須任何處理
    const same =
      next.length === shared.length &&
      next.every((e, i) => e.surface === shared[i]?.surface && e.reading === shared[i]?.reading) &&
      sameSongs(nextSongs, sharedSongs);
    if (same) return false;

    shared = next;
    sharedSongs = nextSongs;
    merge();
    notify();
    return true;
  } catch (err) {
    console.warn(`${LOG} 取得共用字典失敗,只用內建的:`, err);
    return false;
  }
}

/** 兩份限定單曲的條目是否相同。僅比對目前這首,其他首變動不影響畫面。 */
function sameSongs(a, b) {
  const left = a[currentSong] ?? [];
  const right = b[currentSong] ?? [];
  return (
    left.length === right.length &&
    left.every((e, i) => e.surface === right[i]?.surface && e.reading === right[i]?.reading)
  );
}

/**
 * 切換曲目。回傳生效清單是否隨之變動 —— 變動了才需要重新轉換畫面上的歌詞。
 *
 * 沒有專屬條目的歌佔絕大多數,故此處幾乎都回傳 false;
 * 那正是重點:不應為了換歌就將每一行重轉一次,那會使頁面卡頓。
 *
 * @param {string} title 曲名(原樣傳入即可,正規化在內部處理)
 * @returns {boolean}
 */
export function setCurrentSong(title) {
  const next = normalizeSongTitle(title);
  if (next === currentSong) return false;

  const before = songEntries(currentSong);
  currentSong = next;
  const after = songEntries(next);

  // 兩邊皆無專屬條目時合併結果必然相同,毋須重算亦毋須通知
  if (!before.length && !after.length) return false;

  merge();
  notify();
  return true;
}

/** 這首歌的專屬條目筆數,供畫面提示使用。 */
export function getSongCorrectionCount() {
  return songEntries(currentSong).length;
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(entries);
    } catch (err) {
      console.warn(`${LOG} 修正字典的訂閱者發生錯誤:`, err);
    }
  }
}

/** 自 storage 載入,並灌入 corrections.js 的生效清單 */
export async function loadUserCorrections() {
  try {
    const stored = await chrome.storage.sync.get(KEY);
    const value = stored[KEY];
    entries = value?.v === VERSION && value.entries ? { ...value.entries } : {};
  } catch (err) {
    console.warn(`${LOG} 讀取自訂讀音失敗,先用內建的:`, err);
    entries = {};
  }
  merge();
  return entries;
}

async function persist(next) {
  const payload = { v: VERSION, entries: next, updatedAt: Date.now() };
  const bytes = new TextEncoder().encode(JSON.stringify({ [KEY]: payload })).length;

  if (bytes > QUOTA_BYTES) {
    return { ok: false, reason: 'quota', bytes };
  }

  try {
    await chrome.storage.sync.set({ [KEY]: payload });
  } catch (err) {
    console.warn(`${LOG} 寫入自訂讀音失敗:`, err);
    return { ok: false, reason: 'write-failed' };
  }

  // sync 有配額限制且同步本身亦可能失敗,本機再留一份作為保險
  chrome.storage.local.set({ [`${KEY}.backup`]: payload }).catch(() => {});

  entries = next;
  merge();
  notify();
  return { ok: true, bytes };
}

/**
 * 新增或覆寫一筆自訂讀音。
 * @param {string} surface 原文(須為完整的詞,不可只取其中一個字)
 * @param {string} reading 假名讀音
 */
export async function addUserCorrection(surface, reading) {
  if (!surface) return { ok: false, reason: 'empty-surface' };
  if (!isValidReading(reading)) return { ok: false, reason: 'bad-reading' };
  return persist({ ...entries, [surface]: reading });
}

export async function removeUserCorrection(surface) {
  if (!(surface in entries)) return { ok: true, bytes: 0 };
  const next = { ...entries };
  delete next[surface];
  return persist(next);
}

export function getUserCorrections() {
  return entries;
}

/** 訂閱變更(亦包含其他分頁或其他裝置所做的修改) */
export function onCorrectionsChanged(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * 試算「若加入這一筆會成為什麼結果」,不寫入 storage。
 *
 * popover 的即時預覽使用本函式 —— 使用者要靠它看出讀音是否涵蓋整個詞。
 * 僅替換詞的一部分會破壞斷詞(例如將「怨子」的「怨」換掉會成為
 * 「えん子」→ e n ko),預覽會將該類錯誤直接呈現出來。
 */
export function previewCorrections(text, candidate) {
  const list = sortCorrections([
    ...BUILTIN.filter((b) => !(b.surface in entries) && b.surface !== candidate?.surface),
    ...Object.entries(entries)
      .filter(([surface]) => surface !== candidate?.surface)
      .map(([surface, reading]) => ({ surface, reading })),
    ...(candidate ? [candidate] : []),
  ]);
  return applyCorrectionsWith(text, list);
}

// 其他分頁或其他裝置變更了設定時,此處亦須跟上
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[KEY]) return;
  const value = changes[KEY].newValue;
  entries = value?.v === VERSION && value.entries ? { ...value.entries } : {};
  merge();
  notify();
});
