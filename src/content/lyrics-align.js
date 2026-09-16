/**
 * lyrics-align.js
 * 以字元對應,將 LRC 的時間軸套到畫面上的歌詞行。純函式,可於背景程式使用。
 *
 * ── 為何不逐句比對 ────────────────────────────────────────
 * 畫面上的歌詞與 LRCLIB 的同一首歌,**斷行方式經常不同**,而且兩個方向都有
 * (實測 2026-09,7 首日文歌):
 *
 *   Pretender  畫面「君とのラブストーリー それは予想通り」
 *              LRC 拆成「君とのラブストーリー」「それは予想通り」兩句
 *   粉雪       畫面拆成「風に吹かれて」「似たように凍えるのに」
 *              LRC 併為一句
 *
 * 去掉空白與標點後 Pretender 的全文完全相同,逐句比對卻只對到 63%,粉雪只有 34%。
 * 改以「整段文字逐字元對應」即不受斷行影響:同一批歌曲的相符度為 90–100%,
 * 且每一行都取得時間。
 *
 * ── 對齊失敗時不強行套用 ──────────────────────────────────
 * 沿用 sync-highlight.js 既有的原則。相符度即為判準:實測正確的版本落在
 * 90–100%,挑錯版本(Lemon 的羅馬拼音版)為 0%,中間有很大的空間。
 * 低於門檻即回傳 aborted,呼叫端不應顯示任何高亮 —— 錯位的高亮比沒有高亮更糟。
 */

import { normalizeForMatch } from './text-match.js';
import { matchMap, toCodes } from './char-diff.js';

/**
 * 相符度的門檻。
 *
 * 取 0.8 而非更高:粉雪實測為 90%,差異全部是無害的寫法不同
 * (事/こと、返/かえ、締め/しめ)與畫面多出的和聲(ラライ、あぁ)。
 * 再低則開始接近「同語系但不同首歌」的區間,不值得冒險。
 */
export const MIN_MATCH_RATIO = 0.8;

/** 最後一句沒有下一句可界定結束時間,給予一個合理長度 */
const LAST_LINE_MS = 4000;

/** 將每一行正規化後串成一整串,並記錄每一行的起點與長度 */
function flatten(lines) {
  const starts = [];
  const lengths = [];
  let text = '';
  for (const line of lines) {
    const normalized = normalizeForMatch(line);
    starts.push(text.length);
    lengths.push(normalized.length);
    text += normalized;
  }
  return { text, starts, lengths };
}

/** 位置落在第幾行(starts 為遞增,採二分搜尋) */
function lineIndexAt(starts, position) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * 某個字元位置對應的時間。
 *
 * 落在 LRC 某句的中途時(畫面把該句拆成兩行),依字元比例於該句與下一句之間內插。
 * 直接取該句的開頭會使拆出來的第二行與第一行同時亮起。
 * 此為估算 —— 該句內部的實際節奏無從得知,但比兩行共用同一個時間接近事實。
 */
function timeAt(lrcLines, index, offsetInLine, lineLength) {
  const start = lrcLines[index].timeMs;
  if (offsetInLine <= 0 || !lineLength) return start;

  const end = index + 1 < lrcLines.length ? lrcLines[index + 1].timeMs : start + LAST_LINE_MS;
  if (end <= start) return start; // 時間軸資料異常時不外推

  return Math.round(start + ((end - start) * offsetInLine) / lineLength);
}

/**
 * 將 LRC 時間軸對應至畫面上的歌詞行。
 *
 * @param {string[]} displayLines 畫面上每一行的原文
 * @param {Array<{ timeMs: number, text: string }>} lrcLines parseLrc() 的結果
 * @param {{ minRatio?: number }} [options]
 * @returns {{ times: Array<number|null>, coverage: number, anchored: number, aborted: boolean }}
 *   times 與 displayLines 等長,無法對應的行為 null;
 *   coverage 為畫面文字對應到的字元比例(即相符度);
 *   anchored 為取得時間的行數比例;
 *   aborted 為 true 時 times 全為 null,呼叫端不應套用高亮。
 */
export function alignByChars(displayLines, lrcLines, { minRatio = MIN_MATCH_RATIO } = {}) {
  const times = new Array(displayLines?.length ?? 0).fill(null);
  const empty = { times, coverage: 0, anchored: 0, aborted: true };

  // 僅有時間而無文字的行是間奏,不參與比對 —— 但仍留在 lrcLines 中供內插取用結束時間
  const timed = (lrcLines ?? []).filter((line) => line.text);
  if (!displayLines?.length || !timed.length) return empty;

  const display = flatten(displayLines);
  const lrc = flatten(timed.map((line) => line.text));
  if (!display.text.length || !lrc.text.length) return empty;

  const { map, matched, aborted } = matchMap(toCodes(display.text), toCodes(lrc.text), { minRatio });
  if (aborted) return empty;

  let anchored = 0;
  for (let i = 0; i < displayLines.length; i += 1) {
    const from = display.starts[i];
    const to = from + display.lengths[i];

    // 取這一行第一個對應得到的字元。整行都沒有對應(畫面多出的和聲、空行)即留 null,
    // 由呼叫端決定如何處理 —— 此處不猜測
    let position = -1;
    for (let p = from; p < to; p += 1) {
      if (map[p] >= 0) {
        position = p;
        break;
      }
    }
    if (position < 0) continue;

    const k = lineIndexAt(lrc.starts, map[position]);
    times[i] = timeAt(timed, k, map[position] - lrc.starts[k], lrc.lengths[k]);
    anchored += 1;
  }

  return {
    times,
    coverage: matched / display.text.length,
    anchored: anchored / displayLines.length,
    aborted: false,
  };
}
