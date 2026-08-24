/**
 * lrc.js
 * LRC 時間軸解析。純函式,不涉及 DOM 與 chrome API,可直接以 Node 測試。
 *
 * LRCLIB 的 syncedLyrics 欄位即為此格式:
 *
 *   [mm:ss.xx] 歌詞文字
 *
 * 取得每句的起訖時間後,配合實際播放進度即可算出目前句次,以及該句的完成比例,
 * 後者為逐字高亮所需。此作法較觀察 Spotify 畫面準確,且無先天延遲。
 */

/** [mm:ss.xx] / [mm:ss.xxx] / [mm:ss];分鐘允許超過兩位數(部分長音軌) */
const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** 整體位移標籤,例如 [offset:-500] */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * 逐字時間標籤 <mm:ss.xx>,位於歌詞文字之間(enhanced LRC)。
 *
 * 此為唯一能確知句內進度的資料來源。僅有句首時間時,句內進度只能估算,
 * 而唱得快與唱得慢的句子在資料上完全相同,調整參數只能改變偏差方向,無法消除。
 * 少數 LRCLIB 條目提供此標籤,存在時即採用,可精準至詞。
 */
const WORD_TAG = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

/**
 * 將 [mm:ss.xx] 的三個捕獲群組換算為毫秒。
 * 小數兩位為百分之一秒,三位為千分之一秒。
 */
function toMs(minutes, seconds, fraction) {
  let ms = Number(minutes) * 60_000 + Number(seconds) * 1000;
  if (fraction) {
    ms += fraction.length === 3 ? Number(fraction) : Number(fraction) * 10;
  }
  return ms;
}

/**
 * 取出一行中的逐字時間標籤。
 *
 * 格式為 <時間>文字<時間>文字…,每個標籤標記的是其後方該段文字的起唱時間。
 * 無標籤時回空陣列,表示該曲僅有句層級的時間軸。
 *
 * @returns {Array<{timeMs: number, text: string}>}
 */
function parseWords(content, offsetMs) {
  WORD_TAG.lastIndex = 0;

  const words = [];
  let pendingTime = null;
  let sliceFrom = 0;
  let match;

  while ((match = WORD_TAG.exec(content)) !== null) {
    if (pendingTime !== null) {
      words.push({ timeMs: pendingTime, text: content.slice(sliceFrom, match.index) });
    }
    pendingTime = Math.max(0, toMs(match[1], match[2], match[3]) - offsetMs);
    sliceFrom = match.index + match[0].length;
  }

  // 最末標籤之後的文字
  if (pendingTime !== null) {
    words.push({ timeMs: pendingTime, text: content.slice(sliceFrom) });
  }

  return words.filter((w) => w.text.trim());
}

/**
 * 解析 LRC。
 *
 * @param {string} text LRCLIB 的 syncedLyrics 原文
 * @returns {{ offsetMs: number, lines: Array<{ timeMs: number, text: string }> }}
 *          解析不出任何時間標籤時回空陣列,呼叫端須退回使用 plainLyrics
 */
export function parseLrc(text) {
  const empty = { offsetMs: 0, lines: [] };
  if (typeof text !== 'string' || !text) return empty;

  // 移除 BOM,統一換行
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // offset 的正負號各實作不一致,此處採最常見的約定:
  // 正值代表歌詞提前顯示,故自時間戳減去。
  const offsetMatch = normalized.match(OFFSET_TAG);
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0;

  const lines = [];

  for (const raw of normalized.split('\n')) {
    TIME_TAG.lastIndex = 0;

    // 同一行可能帶有多個時間標籤(重複的副歌),每個皆視為一句
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(raw)) !== null) {
      stamps.push(toMs(match[1], match[2], match[3]));
    }
    if (!stamps.length) continue; // metadata 行([ar:]、[ti:] 等)

    // 句首標籤位於行首,移除後餘下的內容可能仍夾有逐字標籤
    const content = raw.replace(TIME_TAG, '').trim();
    const words = parseWords(content, offsetMs);
    const text = content.replace(WORD_TAG, '').trim();

    for (const stamp of stamps) {
      // 僅有時間而無文字的行為間奏,須保留:高亮需要停留的位置,
      // 否則間奏期間會持續停在上一句
      lines.push({
        timeMs: Math.max(0, stamp - offsetMs),
        text,
        ...(words.length ? { words } : {}),
      });
    }
  }

  if (!lines.length) return empty;

  // 多標籤展開後順序不定,且後續採二分搜尋,必須排序
  lines.sort((a, b) => a.timeMs - b.timeMs);

  return { offsetMs, lines };
}

/**
 * 取得 positionMs 當下的句次。
 * 二分搜尋:回傳最後一個 timeMs <= positionMs 的索引。
 *
 * @returns {number} 尚未進入第一句時回 -1
 */
export function findLineAt(lines, positionMs) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/**
 * 該句的完成比例(0~1),為逐字高亮的依據。
 *
 * @param {Array<{timeMs:number}>} lines
 * @param {number} index 目前句次
 * @param {number} positionMs 目前播放位置
 * @param {number} fallbackDurationMs 最後一句無後續句可計算長度時採用的預設值
 * @returns {number} 0~1
 */
export function lineProgress(lines, index, positionMs, fallbackDurationMs = 4000) {
  if (index < 0 || index >= lines.length) return 0;

  const start = lines[index].timeMs;
  const next = lines[index + 1];
  const duration = next ? next.timeMs - start : fallbackDurationMs;
  if (duration <= 0) return 1;

  const ratio = (positionMs - start) / duration;
  return Math.min(1, Math.max(0, ratio));
}
