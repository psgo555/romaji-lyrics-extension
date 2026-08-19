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

/** 讀音只接受假名與長音符 —— 混進漢字等於沒修正到 */
export const READING_PATTERN = /^[ぁ-ゟ゠-ヿー]+$/u;

export function isValidReading(reading) {
  return READING_PATTERN.test(reading ?? '');
}

/** 內建的 + 使用者的,同一個原文以使用者的為準 */
function merge() {
  const overridden = new Set(Object.keys(entries));
  const list = [
    ...BUILTIN.filter((b) => !overridden.has(b.surface)),
    ...Object.entries(entries).map(([surface, reading]) => ({ surface, reading })),
  ];
  setActiveCorrections(list);
  return list;
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
