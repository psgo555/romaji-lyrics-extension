/**
 * shared-dictionary.js
 * 驗證從網路抓回來的共用讀音字典。
 *
 * ── 為什麼這支要特別嚴 ────────────────────────────────────────
 * 這是整個專案裡**唯一會影響畫面、內容卻不由自己掌控**的資料。
 * 它從 GitHub 抓回來,而沒擋好的話壞法有兩種:
 *
 *   1. 格式壞掉 → 轉換流程炸掉,使用者連原本能用的拼音都沒了
 *   2. 內容壞掉 → 畫面**很有自信地顯示錯的拼音**,而沒人知道那是錯的
 *
 * 第二種更糟。轉不出來的字至少會原樣顯示,使用者看得出「這個沒轉」;
 * 但唸錯的拼音跟對的長得一模一樣。
 *
 * 所以原則是:**寧可整份丟掉,也不要放進可疑的東西**。
 * 單筆有問題就跳過那一筆,結構有問題就整份不要 —— 反正還有內建字典,
 * 退回去只是少了新詞,不會壞掉。
 *
 * 這支不碰 chrome 也不碰網路,純資料驗證,可以直接用 Node 測。
 */

import { isValidReading } from '../content/reading.js';

/** 認得的格式版本。改格式時一起改這裡,舊版擴充功能會自動忽略新格式。 */
export const SUPPORTED_VERSION = 1;

/*
 * 數量與長度上限。
 *
 * 不是怕檔案大,是怕**出事的時候**:萬一有一筆 surface 長達幾萬字,
 * applyCorrectionsWith 是對每個位置拿整張表去比對的,那會讓每一行歌詞
 * 都慢下來,而使用者只會覺得「這擴充功能好卡」,查不到原因。
 */
const MAX_ENTRIES = 5000;
const MAX_SURFACE_LENGTH = 40;
const MAX_READING_LENGTH = 60;

/**
 * 把抓回來的內容驗成一份可以用的修正表。
 *
 * @param {unknown} raw 已經 JSON.parse 過的內容
 * @returns {{ entries: Array<{surface: string, reading: string}>, skipped: number }}
 *          結構有問題時 entries 是空陣列 —— 呼叫端就退回內建字典
 */
export function parseSharedDictionary(raw) {
  const empty = { entries: [], skipped: 0 };

  if (!raw || typeof raw !== 'object') return empty;
  if (raw.version !== SUPPORTED_VERSION) return empty; // 認不得的版本整份不要
  if (!Array.isArray(raw.entries)) return empty;

  const entries = [];
  const seen = new Set();
  let skipped = 0;

  for (const item of raw.entries.slice(0, MAX_ENTRIES)) {
    if (!isUsableEntry(item, seen)) {
      skipped += 1;
      continue;
    }
    seen.add(item.surface);
    // 只留需要的兩個欄位 —— note 是給人看的,不要讓它流進轉換流程
    entries.push({ surface: item.surface, reading: item.reading });
  }

  // 超過上限被截掉的那些也算跳過,數字才誠實
  skipped += Math.max(0, raw.entries.length - MAX_ENTRIES);

  return { entries, skipped };
}

/**
 * 這一筆能不能用。
 * 每一條都是為了擋掉一種具體的壞法,不是形式上的檢查。
 */
function isUsableEntry(item, seen) {
  if (!item || typeof item !== 'object') return false;

  const { surface, reading } = item;
  if (typeof surface !== 'string' || typeof reading !== 'string') return false;
  if (!surface || !reading) return false;

  if (surface.length > MAX_SURFACE_LENGTH) return false;
  if (reading.length > MAX_READING_LENGTH) return false;

  // 同一個原文出現兩次時以先出現的為準,不要讓後面的偷偷蓋掉
  if (seen.has(surface)) return false;

  /*
   * reading 必須是假名 —— 只有一個例外:寫成跟 surface 一樣代表
   * 「原樣放過」,那是守衛條目的用法(見 一人称)。
   *
   * 少了這道檢查,有人填了漢字或英文進來,轉出來的結果會混著沒轉的東西,
   * 而且因為進了修正表,那個錯誤會蓋過 kuromoji 本來正確的判斷。
   */
  if (reading === surface) return true;
  return isValidReading(reading);
}
