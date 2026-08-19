/**
 * lyrics-fallback.js
 * 當 Spotify 頁面上抓不到歌詞時(例如免費帳號被 paywall 擋住,
 * 或該首歌根本沒有歌詞),改用 LRCLIB 第三方 API 取得歌詞。
 *
 * 注意:這段 fetch 建議放在 Extension 的 background/service worker 執行,
 * 不要放在 content script 直接對 Spotify 頁面發送跨網域請求,
 * 一方面避免受頁面 CSP(connect-src)影響,
 * 二方面 background 環境更適合統一管理 API 請求與快取。
 */

const LRCLIB_ENDPOINT = 'https://lrclib.net/api/search';

/**
 * 用歌名 + 歌手名搜尋歌詞
 * @param {string} trackName
 * @param {string} artistName
 * @returns {Promise<string|null>} 純文字歌詞,找不到則回傳 null
 */
async function fetchLyricsFromLRCLIB(trackName, artistName) {
  const url = `${LRCLIB_ENDPOINT}?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;

  try {
    const res = await fetch(url, {
      headers: {
        // LRCLIB 官方建議帶上自訂 client 標頭表明身份
        'Lrclib-Client': 'romaji-lyrics-extension/0.1.0 (contact: your-email@example.com)',
      },
    });

    if (!res.ok) {
      console.warn(`[LRCLIB] 查詢失敗,狀態碼: ${res.status}`);
      return null;
    }

    const results = await res.json();
    if (!results || results.length === 0) return null;

    // 取第一筆結果,優先使用純文字歌詞(plainLyrics)
    const best = results[0];
    return best.plainLyrics || null;
  } catch (err) {
    console.error('[LRCLIB] 請求發生錯誤:', err);
    return null;
  }
}

/**
 * 主要 fallback 流程:
 * content script 抓不到歌詞時,呼叫這個函式取得歌詞,
 * 再走跟 DOM 抓取模式一樣的羅馬拼音轉換與顯示邏輯。
 */
async function getFallbackLyrics(trackName, artistName) {
  const lyrics = await fetchLyricsFromLRCLIB(trackName, artistName);
  if (!lyrics) {
    console.warn(`[Fallback] 找不到「${trackName}」的歌詞,顯示原樣,不進行轉換`);
    return null;
  }
  return lyrics.split('\n').filter((line) => line.trim().length > 0);
}
