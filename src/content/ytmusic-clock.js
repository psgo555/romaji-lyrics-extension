/**
 * ytmusic-clock.js
 * YouTube Music 的播放進度。
 *
 * ── 為何不用播放器的 API ──────────────────────────────────
 * `#movie_player.getCurrentTime()` 於 DevTools 主控台可用,規劃書即據此撰寫。
 * 但 content script 執行於 isolated world,看不見頁面掛在元素上的自訂方法 ——
 * 實測(2026-09)在該環境中 `typeof getCurrentTime` 為 `undefined`,
 * getVideoData 亦同。主控台屬於主世界,兩者並不相同。
 *
 * 改讀 `<video>` 的 currentTime:那是標準 DOM 屬性,isolated world 讀得到,
 * 精度同為浮點秒。因此仍毋須 playback-clock.js 為 Spotify 所做的那套估算
 * (Spotify 網頁版頁面上根本沒有媒體元素,那是另一回事)。
 *
 * ── 廣告 ────────────────────────────────────────────────
 * 廣告期間 `<video>` 播的是廣告,currentTime 自 0 起算,直接採用會使高亮跳回
 * 歌曲開頭並停在那裡。實測的分辨方式為 `#movie_player` 的 class:
 *
 *   廣告中  ad-created ad-showing ad-interrupting …
 *   歌曲中  ad-created …                            ← showing 與 interrupting 皆消失
 *
 * **ad-created 不可用**:它代表「本次工作階段曾播過廣告」,歌曲播放時仍然留著。
 * 「廣告元素是否存在於 DOM」同樣不可用 —— 那些元素在歌曲期間也還在,只是隱藏。
 */

const PLAYER_SELECTOR = '#movie_player';

/** 僅認 ad-showing 與 ad-interrupting,不可放寬為 /ad-/(理由見檔頭) */
const AD_CLASS = /(^|\s)ad-(showing|interrupting)(\s|$)/;

/**
 * 播放器的 class 是否代表正在播廣告。
 * @param {unknown} className `#movie_player` 的 className
 */
export function isAdClassName(className) {
  return AD_CLASS.test(String(className ?? ''));
}

/**
 * 秒 → 毫秒。取不到、非有限值或負數皆回 null。
 *
 * 換曲的瞬間 `<video>` 的 currentTime 與 duration 會短暫為 NaN,
 * 那時不應據以計算高亮。
 *
 * @param {unknown} seconds
 * @returns {number|null}
 */
export function positionMsFrom(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/** 目前是否在播廣告。取不到播放器時視為否(頁面尚未就緒,交由下方的 video 判斷) */
function adPlaying() {
  const player = document.querySelector(PLAYER_SELECTOR);
  return player ? isAdClassName(player.className) : false;
}

/**
 * 目前的播放位置(毫秒)。正在播廣告、找不到媒體元素或數值不可用時回 null。
 *
 * 回傳 null 即代表「此刻不知道唱到哪裡」,呼叫端應清除高亮而非沿用舊值 ——
 * 停在最後一句的高亮看起來像是壞了。
 */
export function getYtmPositionMs() {
  if (adPlaying()) return null;
  const video = document.querySelector('video');
  return video ? positionMsFrom(video.currentTime) : null;
}

/** 曲目長度(毫秒)。用於向 LRCLIB 區分單曲版與 Live 版,取不到回 null。 */
export function getYtmDurationMs() {
  if (adPlaying()) return null;
  const video = document.querySelector('video');
  const ms = video ? positionMsFrom(video.duration) : null;
  return ms || null; // 0 代表尚未載入完成
}
