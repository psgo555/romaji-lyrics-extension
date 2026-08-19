/**
 * lrc.js
 * LRC 歌詞時間軸解析。純函式,不碰 DOM 也不碰 chrome API,可以直接用 Node 測。
 *
 * LRCLIB 的 syncedLyrics 欄位就是這個格式:
 *   [mm:ss.xx] 歌詞文字
 *
 * 拿到每一句的起訖時間之後,配上實際播放進度就能算出
 * 「現在唱到第幾句」以及「這句唱到幾成」—— 後者是逐字掃過去的高亮所需要的。
 * 這比去觀察 Spotify 的畫面準得多,而且沒有先天延遲。
 */

/** [mm:ss.xx] / [mm:ss.xxx] / [mm:ss];分鐘允許超過兩位數(有些長音軌) */
const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** [offset:-500] 這種整體位移標籤 */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * 逐字時間標籤 <mm:ss.xx>,夾在歌詞文字中間(enhanced LRC)。
 *
 * 這是唯一能真正知道「句子內部唱到哪」的資料來源。
 * 只有句首時間的話,句內進度只能用估的 —— 而「唱得快」跟「唱得慢」的句子
 * 在資料上長得一模一樣,參數怎麼調都只能換邊、不能消除誤差。
 * 少數 LRCLIB 條目有這個,有就用,精準到詞。
 */
const WORD_TAG = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

/**
 * 把 [mm:ss.xx] 的三個捕獲群組換算成毫秒。
 * 小數兩位是百分之一秒、三位是千分之一秒 —— 這裡常被寫錯。
 */
function toMs(minutes, seconds, fraction) {
  let ms = Number(minutes) * 60_000 + Number(seconds) * 1000;
  if (fraction) {
    ms += fraction.length === 3 ? Number(fraction) : Number(fraction) * 10;
  }
  return ms;
}

/**
 * 抽出一行裡的逐字時間標籤。
 *
 * 格式是 <時間>文字<時間>文字…,所以每個標籤標的是**它後面那段文字**
 * 開始唱的時間。沒有標籤時回空陣列(代表這首歌只有句層級的時間軸)。
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

  // 最後一個標籤後面那段
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
 *          解析不出任何時間標籤時回空陣列,呼叫端要退回用 plainLyrics
 */
export function parseLrc(text) {
  const empty = { offsetMs: 0, lines: [] };
  if (typeof text !== 'string' || !text) return empty;

  // 去掉 BOM,統一換行
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // offset 的正負號各家實作不一致。這裡採用最常見的約定:
  // 正值代表「歌詞要提早顯示」,所以是從時間戳減掉。
  const offsetMatch = normalized.match(OFFSET_TAG);
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0;

  const lines = [];

  for (const raw of normalized.split('\n')) {
    TIME_TAG.lastIndex = 0;

    // 同一行可能掛好幾個時間標籤(重複的副歌),每個都要算一句
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(raw)) !== null) {
      stamps.push(toMs(match[1], match[2], match[3]));
    }
    if (!stamps.length) continue; // 純 metadata 行([ar:]、[ti:] 等)

    // 句首標籤都在最前面,拿掉之後剩下的可能還夾著逐字標籤
    const content = raw.replace(TIME_TAG, '').trim();
    const words = parseWords(content, offsetMs);
    const text = content.replace(WORD_TAG, '').trim();

    for (const stamp of stamps) {
      // 只有時間沒有文字的行是間奏,要保留 —— 高亮需要有地方待著,
      // 否則間奏時會一直亮在上一句上
      lines.push({
        timeMs: Math.max(0, stamp - offsetMs),
        text,
        ...(words.length ? { words } : {}),
      });
    }
  }

  if (!lines.length) return empty;

  // 多標籤展開後順序會亂,而且後面要做二分搜尋,一定要排好
  lines.sort((a, b) => a.timeMs - b.timeMs);

  return { offsetMs, lines };
}

/**
 * 找出 positionMs 當下是第幾句。
 * 二分搜尋:回傳最後一個 timeMs <= positionMs 的索引。
 *
 * @returns {number} 還沒到第一句時回 -1
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
 * 這一句唱到幾成(0~1)。逐字掃過去的高亮就是靠這個值。
 *
 * @param {Array<{timeMs:number}>} lines
 * @param {number} index 目前是第幾句
 * @param {number} positionMs 目前播放位置
 * @param {number} fallbackDurationMs 最後一句沒有下一句可以算長度時用的預設值
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
