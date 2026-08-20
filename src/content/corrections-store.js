/**
 * corrections-store.js
 * 使用者自訂讀音的儲存層。
 *
 * 為什麼需要:kuromoji 的內建辭典(IPADIC)一定會有讀不出來或讀錯的詞 ——
 * 罕用漢字、專有名詞、歌詞裡的特殊寫法。每遇到一個就要改程式碼重新 build
 * 太慢了,所以讓使用者直接在畫面上補,存進瀏覽器、立刻生效、之後所有歌曲通用。
 *
 * 職責分工:
 * - corrections.js  純邏輯,不碰 chrome API(Node 測試會直接匯入它)
 * - 這一支          負責讀寫 chrome.storage,把合併後的表灌回去
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
 * chrome.storage.sync 的限制:單一項目 8192 bytes、總共 102400 bytes。
 * 超過就整筆寫入失敗,而且不太會有明顯的錯誤 —— 使用者只會覺得「存不進去」。
 * 所以寫入前先量,留一點餘裕就擋下來並明白告訴他。
 */
const QUOTA_BYTES = 7000;

/** 目前的使用者修正 { 原文: 讀音 } */
let entries = {};
const listeners = new Set();

/*
 * 讀音的驗證搬到 reading.js 了 —— 跟「把輸入轉成假名」放在一起,
 * 那兩件事是同一個問題的兩面,拆開放的話放寬了其中一邊就會對不上。
 * 另一個原因:這支檔案有 module-level 的 chrome 呼叫、Node 測不到,
 * 而讀音驗證正是最需要測的部分。
 *
 * 注意這裡是**兩行**,不是一行。
 *
 * `export { x } from './y.js'` 只是把 x 轉給別的模組用,**不會**在這支檔案裡
 * 建立一個叫 x 的名字。下面 addUserCorrection 自己要呼叫 isValidReading,
 * 所以還需要一個真正的 import。
 *
 * 少了 import 那行的症狀:打包不報錯、載入也不報錯,一路要到使用者
 * 真的按下儲存才炸 ReferenceError —— 而且畫面上只會顯示「存不了」。
 * (這就是它上線的方式,不是假設。)
 */
import { isValidReading } from './reading.js';
export { READING_PATTERN, isValidReading } from './reading.js';

// 曲名的正規化必須跟驗證那一支用同一份 —— 各寫一份的話,
// 字典裡收的曲名跟這裡查的曲名會在空白或大小寫上悄悄對不上。
import { normalizeSongTitle } from '../shared/shared-dictionary.js';

/** 大家共用的那份(從 GitHub 抓回來的),還沒抓到之前是空的 */
let shared = [];

/**
 * 共用字典裡**限定單曲**的條目,{ 正規化曲名: [{surface, reading}] }。
 *
 * 為什麼要分這一層:回報的人沒辦法判斷一筆修正在別的歌裡安不安全。
 * 「失 → な」在某首歌是對的,全域生效卻會讓失敗變成なはい。
 * 綁在一首歌上就不必判斷 —— 錯了也只錯那一首,而同一首歌的其他人
 * 直接拿到修好的結果,不必每個人再修一次。
 */
let sharedSongs = {};

/** 現在在播哪一首(正規化過的曲名) */
let currentSong = '';

function songEntries(title) {
  return sharedSongs[title] ?? [];
}

/**
 * 把四層合成一份生效清單。
 *
 * 優先順序:**使用者自己的 > 這首歌專屬的 > 共用通用的 > 內建的**
 *
 * 這首歌專屬的排在通用的前面,是因為它更具體:有人特地為這首歌回報,
 * 代表通用那筆在這首歌裡不對(或根本沒有)。具體的規則本來就該蓋過概括的。
 *
 * 為什麼使用者最大:他看得到自己那首歌的實際結果,而共用字典是為了
 * 「大多數情況」收的。萬一某個詞在他聽的歌裡是另一種讀法,
 * 他改完卻被共用的蓋回去,那個功能等於壞了。
 *
 * 為什麼共用的排在內建前面:內建那份是隨擴充功能發布的,更新要等新版;
 * 共用那份改完幾小時內就到。同一個詞兩邊都有時,新的那份比較可能是修好的。
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
 * 去要一份共用字典並套用。抓不到就維持現狀,不要清空。
 *
 * 呼叫端拿到 true 代表清單真的變了 —— 那時才需要重轉畫面上的歌詞,
 * 沒變的話重轉只是白白讓頁面卡一下。
 *
 * @returns {Promise<boolean>} 生效清單有沒有變動
 */
export async function loadSharedDictionary() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'FETCH_DICTIONARY' });
    const next = Array.isArray(res?.entries) ? res.entries : [];
    const nextSongs = res?.songs && typeof res.songs === 'object' ? res.songs : {};
    if (!next.length && !Object.keys(nextSongs).length) return false;

    // 內容一樣就什麼都不用做
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

/** 兩份限定單曲的條目一不一樣。只比目前這首,其他首換了也不影響畫面。 */
function sameSongs(a, b) {
  const left = a[currentSong] ?? [];
  const right = b[currentSong] ?? [];
  return (
    left.length === right.length &&
    left.every((e, i) => e.surface === right[i]?.surface && e.reading === right[i]?.reading)
  );
}

/**
 * 換歌了。回傳生效清單有沒有跟著變 —— 變了才需要重轉畫面上的歌詞。
 *
 * 沒有專屬條目的歌佔絕大多數,所以這裡幾乎都回 false;
 * 那正是重點:不要為了換歌就把每一行重轉一次,那會讓頁面卡一下。
 *
 * @param {string} title 曲名(原樣傳進來即可,正規化在裡面做)
 * @returns {boolean}
 */
export function setCurrentSong(title) {
  const next = normalizeSongTitle(title);
  if (next === currentSong) return false;

  const before = songEntries(currentSong);
  currentSong = next;
  const after = songEntries(next);

  // 兩邊都沒有專屬條目,合併結果一定一樣,不必重算也不必通知
  if (!before.length && !after.length) return false;

  merge();
  notify();
  return true;
}

/** 這首歌有幾筆專屬條目。給畫面上提示用的。 */
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

/** 從 storage 載入,並灌進 corrections.js 的生效清單 */
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

  // sync 空間有配額也可能同步失敗,本機再留一份保險
  chrome.storage.local.set({ [`${KEY}.backup`]: payload }).catch(() => {});

  entries = next;
  merge();
  notify();
  return { ok: true, bytes };
}

/**
 * 新增或覆寫一筆自訂讀音。
 * @param {string} surface 原文(要是完整的詞,不能只取其中一個字)
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

/** 訂閱變更(也包含其他分頁/其他裝置改的) */
export function onCorrectionsChanged(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * 試算「如果加了這一筆會變成怎樣」,不寫進 storage。
 *
 * popover 的即時預覽用這個 —— 使用者要靠它看出讀音有沒有涵蓋整個詞。
 * 只替換詞的一部分會破壞斷詞(例如把「怨子」的「怨」換掉會變成
 * 「えん子」→ e n ko),預覽會把這種錯誤直接顯示出來。
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

// 其他分頁或其他裝置改了設定,這裡也要跟上
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[KEY]) return;
  const value = changes[KEY].newValue;
  entries = value?.v === VERSION && value.entries ? { ...value.entries } : {};
  merge();
  notify();
});
