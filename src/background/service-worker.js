/**
 * background/service-worker.js
 * 由 legacy/lyrics-fallback.js 改寫。
 *
 * 為什麼放在 service worker(README 限制 #3):
 * - 不受 Spotify 頁面 CSP 的 connect-src 限制
 * - 所有分頁共用同一份快取,不會每開一個分頁就重打一次 API
 * - 併發請求可以在這裡去重
 */

/*
 * 借用 content script 那邊的日文判定。
 *
 * 為什麼不在這裡自己寫一個「有沒有日文」的判斷:那件事已經有一套了,
 * 而且涵蓋的範圍比隨手寫的正規表達式廣得多(疊字符、半形片假名、
 * 擴充漢字區)。同一個問題寫兩份答案,遲早會有一邊改了另一邊沒改 ——
 * 這個專案已經在「長音符」跟「曲目長度」上各踩過一次了。
 *
 * cjk.js 不 import 任何東西、也不碰畫面或擴充功能的介面,
 * 所以背景程式可以安心引用。
 */
import { hasJapanese } from '../content/cjk.js';
import { parseSharedDictionary } from '../shared/shared-dictionary.js';

const LRCLIB_ENDPOINT = 'https://lrclib.net/api/search';
/*
 * LRCLIB 要求標明來源,好在出問題時能聯絡開發者。
 *
 * 這個值由 build.mjs 從 package.json 注入(名稱 / 版本 / 專案網址),
 * 這裡刻意不寫死 —— 先前寫死的那份填的是不存在的網址(github.com/local/…),
 * 等於規避了那個要求;而且版本號也不會跟著 package.json 走,遲早對不上。
 *
 * 萬一沒被注入(例如有人直接用 Node 跑這支檔案),退回一個誠實的標示,
 * 不要假裝成某個不存在的專案。
 */
const CLIENT_HEADER =
  typeof __LRCLIB_CLIENT__ === 'string' ? __LRCLIB_CLIENT__ : 'romaji-lyrics-extension (unbundled)';
const CACHE_PREFIX = 'lrclib:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const FETCH_TIMEOUT_MS = 10_000; // 單次 LRCLIB 請求上限
const RESPONSE_TIMEOUT_MS = 15_000; // 訊息通道保險絲,要比 FETCH_TIMEOUT_MS 長

const LOG = '[romaji/bg]';

/** 同一首歌同時被問多次時共用同一個 Promise */
const inFlight = new Map();

function cacheKey(trackName, artistName) {
  return `${CACHE_PREFIX}${trackName}|${artistName}`;
}

/**
 * 快取格式版本。認不得的版本一律當成 miss 重抓,自我修復。
 *
 * v2 → v3:多存了 pickedFor(挑這筆時用的曲目長度)。
 * 推進版本號同時也是**修復手段** —— v2 的資料可能是在沒有長度的情況下
 * 挑出來的錯版本(見下方 readCache 的說明),推進版本號會讓那些
 * 已經存錯的資料自動作廢重抓,使用者不必手動清。
 */
const CACHE_VERSION = 3;

/**
 * 讀快取。除了版本與過期,還要確認「這筆是不是用同一個長度挑出來的」。
 *
 * 為什麼長度要納入判斷:同一首歌在 LRCLIB 常有好幾個版本
 * (單曲版、專輯版、Live),長度差很多、時間軸完全不通用。
 * requestLrclib 是拿曲目長度去篩掉不是同一個版本的,
 * 所以「用長度 245 挑出來的」跟「完全沒篩就挑的」是兩個不同的答案,
 * 不能共用同一格。
 *
 * 三種情況:
 * - 呼叫端沒給長度 → 它沒有偏好,存的是什麼都收
 * - 給了長度且跟當初一致 → 命中
 * - 給了長度但當初不是用它挑的 → 當成沒有,重抓一次挑對版本
 */
async function readCache(key, durationSec) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;

  if (entry.v !== CACHE_VERSION || Date.now() - entry.savedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }

  if (durationSec && entry.pickedFor !== durationSec) return null;

  return { lines: entry.lines, synced: entry.synced ?? null };
}

async function writeCache(key, payload, durationSec) {
  await chrome.storage.local.set({
    [key]: { v: CACHE_VERSION, ...payload, pickedFor: durationSec ?? null, savedAt: Date.now() },
  });
}

/**
 * 這一筆歌詞有多少比例的行含日文(0~1)。
 *
 * 用「行」而不是「字」當單位,是因為要分辨的正是**對照版**:
 * 它的日文一句不少,只是每句後面多插了一句翻譯。
 * 按字數算的話兩者差距會被沖淡;按行算則是乾淨的 54% 對 95%。
 *
 * 開頭那幾行製作資訊(作詞、作曲)也算進去 —— 它們含歌手名的漢字,
 * 兩種版本都有,對比較結果沒有影響,不值得為它們多寫一段排除邏輯。
 */
function japaneseRatio(entry) {
  const text = entry?.syncedLyrics || entry?.plainLyrics || '';
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return 0;
  return lines.filter((line) => hasJapanese(line)).length / lines.length;
}

/**
 * 用歌名 + 歌手名向 LRCLIB 搜尋歌詞。
 * @returns {Promise<string[]|null>} 逐行的純文字歌詞,找不到回 null
 */
async function requestLrclib(trackName, artistName, durationSec) {
  const url = `${LRCLIB_ENDPOINT}?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;

  // 沒有逾時的 fetch 可能一直卡著,讓 service worker 被回收時
  // 訊息通道無聲關閉(就是 "message channel closed" 那個警告的來源之一)
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      // LRCLIB 官方建議帶自訂 client 標頭表明身份
      headers: { 'Lrclib-Client': CLIENT_HEADER },
      signal: controller.signal,
    });

    if (!res.ok) {
      // 用 Node 測試時這裡會拿到 403 + HTML(Cloudflare 擋自動化流量)。
      // 從 Chrome 擴充功能發出的請求帶的是真正的瀏覽器指紋,預期不會被擋。
      const hint = res.status === 403 ? '(可能被 Cloudflare 擋下)' : '';
      console.warn(`${LOG} LRCLIB 查詢失敗,狀態碼: ${res.status} ${hint}`);
      return null;
    }

    // 被擋下時可能回 200 + 挑戰頁面,先確認真的是 JSON 再解析
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      console.warn(`${LOG} LRCLIB 回傳的不是 JSON(content-type: ${contentType}),可能是 Cloudflare 挑戰頁`);
      return null;
    }

    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;

    const usable = results.filter((r) => r?.plainLyrics || r?.syncedLyrics);
    if (!usable.length) return null;

    // 同一首歌常有多個版本(單曲版、專輯版、Live),長度差很多的話
    // 時間軸會整個對不上。先用歌曲長度篩掉明顯不是同一個版本的。
    const sameLength = durationSec
      ? usable.filter((r) => Math.abs((r.duration ?? 0) - durationSec) <= 3)
      : [];
    const pool = sameLength.length ? sameLength : usable;

    /*
     * 剩下的用兩個條件排序,挑最好的那一筆。
     *
     * 1. 有時間軸的優先 —— 那才做得到逐句同步,價值最高
     * 2. 同樣有時間軸時,挑日文比例最高的
     *
     * 第 2 點是實測出來的(Lemon,LRCLIB 回了 20 筆):
     * 那些內容是大家上傳的,同一首歌會混著「純日文版」跟
     * 「日文+外語對照版」。對照版每一句都寫兩遍、時間標一模一樣,
     * 日文只佔 54%;純日文版是 95%。
     *
     * 挑到對照版的後果:歌詞面板會每句印兩遍,而且因為兩行的時間相同、
     * activeIndexAt 取的是最後一個符合的,高亮會停在翻譯那一行。
     *
     * 為什麼是「比例最高」而不是「必須有日文」:
     * 使用者也聽中文、英文歌,那些本來就沒有日文。用硬性條件會讓那些歌
     * 從「有歌詞」變成「完全沒歌詞」—— 為了修一個情況弄壞另一個。
     * 改成排序就沒有這個問題:全部都不是日文時,大家分數一樣,
     * 順序不變,行為跟改動前完全相同。
     */
    const best = [...pool].sort(
      (a, b) =>
        Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) ||
        japaneseRatio(b) - japaneseRatio(a)
    )[0];

    return {
      lines: best.plainLyrics
        ? best.plainLyrics.split('\n').map((line) => line.trim()).filter(Boolean)
        : null,
      synced: best.syncedLyrics ?? null,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.warn(`${LOG} LRCLIB 請求逾時(${FETCH_TIMEOUT_MS / 1000} 秒)`);
    } else {
      console.error(`${LOG} LRCLIB 請求發生錯誤:`, err);
    }
    return null;
  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * 對外的主要入口:先看快取,沒有才打 API。
 * 也掛在 globalThis 上,方便在 service worker 的 DevTools 手動測試:
 *   await fetchLyrics('曲名', '歌手名')
 * @returns {Promise<{lines: string[]|null, cached: boolean}>}
 */
async function fetchLyrics(trackName, artistName, durationSec) {
  if (!trackName || !artistName) return { lines: null, synced: null, cached: false };

  const key = cacheKey(trackName, artistName);

  const cached = await readCache(key, durationSec);
  if (cached) {
    console.info(`${LOG} 命中快取: ${key}`);
    return { ...cached, cached: true };
  }

  // 同時進來的兩個請求若帶著不同的長度,答案也會不同,不能共用同一個 Promise
  const flightKey = `${key}|${durationSec ?? ''}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);

  const task = (async () => {
    const result = await requestLrclib(trackName, artistName, durationSec);
    if (result) await writeCache(key, result, durationSec);
    else console.info(`${LOG} 找不到「${trackName}」的歌詞`);
    return { lines: result?.lines ?? null, synced: result?.synced ?? null, cached: false };
  })().finally(() => inFlight.delete(flightKey));

  inFlight.set(flightKey, task);
  return task;
}

globalThis.fetchLyrics = fetchLyrics;

/* ------------------------------------------------- 大家共用的讀音字典 */

/*
 * 字典放在 GitHub 上一個公開檔案,擴充功能定期來抓。
 *
 * 為什麼是這個做法而不是自己架伺服器:
 * - 不用花錢、不用維護,GitHub 幫忙放
 * - 只有維護者能改,所以**品質仍然有人把關** —— 這很重要,
 *   錯的讀音會讓畫面很有自信地顯示錯的拼音,那比轉不出來更糟
 * - 改完不必發新版,合併後幾小時內所有人都拿得到
 * - 只有 GET、不送出任何資料,「這個擴充功能沒有伺服器」的說法仍然成立
 */
const DICTIONARY_URL =
  'https://raw.githubusercontent.com/psgo555/romaji-lyrics-extension/master/dictionary.json';
const DICTIONARY_KEY = 'sharedDictionary';
const DICTIONARY_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時
// 2:多了限定單曲的條目(songs)。舊快取沒有那一欄,換號碼強迫重抓一次。
const DICTIONARY_CACHE_VERSION = 2;

/*
 * 安裝、更新、或(開發時)按下「重新載入擴充功能」都會把快取丟掉,
 * 下一次就會重新抓一份。
 *
 * 為什麼需要:12 小時的快取對一般使用者剛好,但對**剛改完字典的人**
 * 完全不合直覺 —— 他改了檔案、重新載入了擴充功能,畫面卻沒變,
 * 而且沒有任何跡象告訴他是快取的關係。實際踩過這一次。
 *
 * 重新載入本來就是「我要看最新狀態」的意思,快取不該活過那個動作。
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(DICTIONARY_KEY).catch(() => {});
});

/**
 * 取得共用字典。先看快取,過期才連網。
 *
 * 任何一步失敗都回空陣列而不是丟例外 —— 抓不到字典只代表少了幾個新詞,
 * 內建那份還在,不該讓整個轉換流程跟著壞掉。
 */
async function fetchSharedDictionary() {
  const stored = await chrome.storage.local.get(DICTIONARY_KEY);
  const cached = stored[DICTIONARY_KEY];

  if (
    cached?.v === DICTIONARY_CACHE_VERSION &&
    Date.now() - cached.savedAt < DICTIONARY_TTL_MS
  ) {
    return fromCache(cached);
  }

  try {
    const res = await fetch(DICTIONARY_URL, { cache: 'no-cache' });
    if (!res.ok) {
      console.warn(`${LOG} 共用字典下載失敗,狀態碼 ${res.status}`);
      return fromCache(cached); // 過期的也比沒有好
    }

    const { entries, songs, skipped } = parseSharedDictionary(await res.json());
    if (skipped) {
      console.warn(`${LOG} 共用字典有 ${skipped} 筆沒通過驗證,已略過`);
    }

    /*
     * 驗完是空的就**不要覆蓋快取**。
     *
     * 那代表檔案壞了或格式換了。這時把空的存進去,等於把使用者原本
     * 還能用的那份也一起清掉 —— 一個人手滑改壞檔案,所有人的字典就空了。
     */
    const songCount = Object.keys(songs).length;
    if (!entries.length && !songCount) {
      console.warn(`${LOG} 共用字典驗完是空的,沿用先前的`);
      return fromCache(cached);
    }

    await chrome.storage.local.set({
      [DICTIONARY_KEY]: { v: DICTIONARY_CACHE_VERSION, entries, songs, savedAt: Date.now() },
    });
    console.info(`${LOG} 共用字典已更新,${entries.length} 筆通用 + ${songCount} 首歌的專屬條目`);
    return { entries, songs, cached: false };
  } catch (err) {
    console.warn(`${LOG} 取得共用字典失敗,沿用先前的:`, err);
    return fromCache(cached);
  }
}

/**
 * 把快取整理成回應的形狀。
 *
 * 抽出來是因為「抓不到就沿用舊的」在上面出現四次,而每一處都要記得
 * 同時帶上 entries 與 songs —— 漏一個的症狀是限定單曲的修正在
 * 「這次沒連上網」的時候悄悄失效,不會有任何錯誤訊息。
 */
function fromCache(cached) {
  return { entries: cached?.entries ?? [], songs: cached?.songs ?? {}, cached: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FETCH_DICTIONARY') {
    fetchSharedDictionary()
      .then(sendResponse)
      .catch((err) => {
        console.warn(`${LOG} 處理 FETCH_DICTIONARY 失敗:`, err);
        sendResponse({ entries: [], songs: {}, cached: false });
      });
    return true;
  }
  return handleLyricsMessage(message, sendResponse);
});

function handleLyricsMessage(message, sendResponse) {
  // 不是我們的訊息就回 false,把通道讓給其他 listener,不要佔著不回應
  if (message?.type !== 'FETCH_LYRICS') return false;

  // 回應剛好一次。
  // 少回應 → console 會出現「message channel closed before a response was received」;
  // 多回應 → 第二次呼叫 sendResponse 會丟例外。
  let answered = false;
  const respond = (payload) => {
    if (answered) return;
    answered = true;
    try {
      sendResponse(payload);
    } catch (err) {
      // 發送端(分頁)可能已經關閉或重新整理,這時回應失敗是正常的
      console.warn(`${LOG} 回應訊息失敗,發送端可能已關閉:`, err);
    }
  };

  // 保險絲:service worker 有存活上限,萬一 fetch 卡住,
  // 通道會無聲關閉並在 content script 端噴警告。寧可先回一個明確的逾時結果。
  const fuse = setTimeout(() => {
    console.warn(`${LOG} FETCH_LYRICS 逾時,先回空結果`);
    respond({ lines: null, synced: null, cached: false, timedOut: true });
  }, RESPONSE_TIMEOUT_MS);

  fetchLyrics(message.trackName, message.artistName, message.durationSec)
    .then((result) => respond(result))
    .catch((err) => {
      console.error(`${LOG} 處理 FETCH_LYRICS 失敗:`, err);
      respond({ lines: null, synced: null, cached: false });
    })
    .finally(() => clearTimeout(fuse));

  return true; // 保持非同步回應通道開著
}
