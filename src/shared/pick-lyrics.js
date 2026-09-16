/**
 * pick-lyrics.js
 * 自 LRCLIB 的搜尋結果中挑出要用的那一筆。純函式,不相依 chrome 與 DOM。
 *
 * 由 service-worker.js 呼叫。抽出的原因有二:此處是整條流程中唯一「會挑錯」的地方,
 * 需要能以單元測試逐條驗證;且 Spotify 與 YouTube Music 兩個平台共用同一套規則,
 * 兩份實作遲早分岔(本專案已於「長音符」與「曲目長度」各發生過一次)。
 *
 * ── 兩種挑法 ──────────────────────────────────────────────
 * 沒有參考歌詞(Spotify:畫面上本來就沒有歌詞,才會走到備援)
 *   → 有時間軸者優先,其次日文行比例最高者。與抽出前的規則完全相同。
 *
 * 有參考歌詞(YouTube Music:畫面上已有 Musixmatch / LyricFind 的歌詞,只缺時間軸)
 *   → 以字元對齊比對內容,取相符度最高者,並回傳對齊後每一行的時間。
 *     實測(2026-09)必要性:YouTube Music 的歌手名可能是英文(Kenshi Yonezu),
 *     該名稱下的 LRCLIB 條目全是羅馬拼音版,依日文比例挑只會挑到拼音版,
 *     時間軸雖然對得上,文字卻與畫面完全不同。
 *
 * 相符度達不到門檻時不回傳時間(見 lyrics-align.js 的「對齊失敗時不強行套用」)。
 */

import { parseLrc } from '../content/lrc.js';
import { alignByChars } from '../content/lyrics-align.js';
import { hasJapanese } from '../content/cjk.js';

/** 曲目長度容許的誤差:同一首歌的單曲版、專輯版、Live 版長度差異遠大於此 */
const DURATION_TOLERANCE_SEC = 3;

/**
 * 該筆歌詞中含日文的行數比例(0~1)。
 *
 * 以「行」而非「字」為單位,是因為所要分辨的正是對照版:其日文一句不少,
 * 僅在每句後方插入一句翻譯。按字數計算會沖淡兩者的差距,按行計算則為
 * 54% 對 95% 的明確差異。
 */
export function japaneseRatio(entry) {
  const text = entry?.syncedLyrics || entry?.plainLyrics || '';
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return 0;
  return lines.filter((line) => hasJapanese(line)).length / lines.length;
}

/** 可用的結果:至少要有一種歌詞 */
function usableResults(results) {
  return (results ?? []).filter((r) => r?.plainLyrics || r?.syncedLyrics);
}

/**
 * 以曲目長度縮小範圍。
 * 長度不符者一律排除;全部都不符時(未提供長度,或該曲在 LRCLIB 的長度都不對)
 * 退回全部,寧可挑一個可能不同版本的,也不要完全沒有歌詞。
 */
function poolFor(usable, durationSec) {
  if (!durationSec) return usable;
  const sameLength = usable.filter((r) => Math.abs((r.duration ?? 0) - durationSec) <= DURATION_TOLERANCE_SEC);
  return sameLength.length ? sameLength : usable;
}

/** 沒有參考歌詞時的排序:有時間軸優先,其次日文行比例 */
function bestByMetadata(pool) {
  return [...pool].sort(
    (a, b) =>
      Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) || japaneseRatio(b) - japaneseRatio(a)
  )[0];
}

/**
 * 挑出要用的那一筆。
 *
 * @param {Array<object>} results LRCLIB 的搜尋結果
 * @param {{ durationSec?: number, referenceLines?: string[] }} [options]
 *        referenceLines:畫面上已顯示的歌詞行,用於比對內容並產生時間
 * @returns {{ best: object, times: Array<number|null>|null, coverage: number, pickedBy: 'content'|'metadata' }|null}
 *          查無可用結果時回 null;times 為 null 代表沒有可靠的時間軸可用
 */
export function pickLyrics(results, { durationSec, referenceLines } = {}) {
  const usable = usableResults(results);
  if (!usable.length) return null;

  const pool = poolFor(usable, durationSec);

  if (referenceLines?.length) {
    let bestMatch = null;
    for (const entry of pool) {
      if (!entry.syncedLyrics) continue; // 沒有時間軸的條目對「借時間軸」毫無用處
      const aligned = alignByChars(referenceLines, parseLrc(entry.syncedLyrics).lines);
      if (aligned.aborted) continue;
      if (!bestMatch || aligned.coverage > bestMatch.coverage) {
        bestMatch = { best: entry, times: aligned.times, coverage: aligned.coverage, pickedBy: 'content' };
      }
    }
    if (bestMatch) return bestMatch;
    // 一筆都對不上:仍回傳一份歌詞(呼叫端可能只是要文字),但不給時間 ——
    // 對不上的時間軸套到畫面上,只會讓高亮停在錯的句子
  }

  return { best: bestByMetadata(pool), times: null, coverage: 0, pickedBy: 'metadata' };
}

/**
 * 將挑中的結果整理成回應的形狀。
 * 與 pickLyrics 分開,是因為 service-worker 的快取存的正是這個形狀。
 */
export function toPayload(picked) {
  if (!picked) return null;
  const { best, times, coverage, pickedBy } = picked;
  return {
    lines: best.plainLyrics
      ? best.plainLyrics.split('\n').map((line) => line.trim()).filter(Boolean)
      : null,
    synced: best.syncedLyrics ?? null,
    times: times ?? null,
    coverage,
    pickedBy,
  };
}
