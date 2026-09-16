/**
 * background/service-worker.js
 * 歌詞與共用字典的網路存取層,由 legacy/lyrics-fallback.js 改寫。
 *
 * 置於 service worker 的理由(README 限制 #3):
 * - 不受 Spotify 頁面 CSP 的 connect-src 限制
 * - 所有分頁共用同一份快取,不致每開一個分頁便重新請求一次 API
 * - 併發請求可在此處去重
 */

/*
 * 「挑哪一個版本」的規則集中於 shared/pick-lyrics.js,此處不另寫一份。
 *
 * 同一項判斷若存在兩份實作,終將出現一邊修改而另一邊未同步的情形 ——
 * 本專案已於「長音符」與「曲目長度」各發生過一次。該模組亦不相依 chrome 與 DOM,
 * 背景程式可安全引用,且能以單元測試逐條驗證(整條流程中唯一會「挑錯」的地方)。
 */
import { parseSharedDictionary } from '../shared/shared-dictionary.js';
import { pickLyrics, toPayload } from '../shared/pick-lyrics.js';

const LRCLIB_ENDPOINT = 'https://lrclib.net/api/search';
/*
 * LRCLIB 要求請求標明來源,以便在異常時聯絡開發者。
 *
 * 此值由 build.mjs 自 package.json 注入(名稱 / 版本 / 專案網址),不寫死於程式中:
 * 先前寫死的那份填的是不存在的網址(github.com/local/…),形同規避該項要求,
 * 且版本號無法跟隨 package.json 更新。
 *
 * 未被注入時(例如直接以 Node 執行本檔)退回一個據實標示的字串,
 * 不冒用不存在的專案。
 */
const CLIENT_HEADER =
  typeof __LRCLIB_CLIENT__ === 'string' ? __LRCLIB_CLIENT__ : 'romaji-lyrics-extension (unbundled)';
const CACHE_PREFIX = 'lrclib:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const FETCH_TIMEOUT_MS = 10_000; // 單次 LRCLIB 請求上限
const RESPONSE_TIMEOUT_MS = 15_000; // 訊息通道保險絲,須大於 FETCH_TIMEOUT_MS

const LOG = '[romaji/bg]';

/** 同一首歌同時發出多次請求時共用同一個 Promise */
const inFlight = new Map();

function cacheKey(trackName, artistName) {
  return `${CACHE_PREFIX}${trackName}|${artistName}`;
}

/**
 * 快取格式版本。無法辨識的版本一律視為 miss 並重新取得,具自我修復性。
 *
 * v2 → v3:增加 pickedFor(挑選該筆時所用的曲目長度)。
 * 推進版本號同時亦是修復手段 —— v2 的資料可能是在沒有長度資訊的情況下
 * 挑出的錯誤版本(見下方 readCache 的說明),推進版本號可使已存入的錯誤資料
 * 自動作廢重抓,毋須使用者手動清除。
 *
 * v3 → v4:增加 ref(挑選時所依據的畫面歌詞)與對齊結果 times。
 */
const CACHE_VERSION = 4;

/**
 * 挑選時所依據的畫面歌詞的識別值。
 *
 * 快取須據此區分:「依內容挑出的版本」與「依中繼資料挑出的版本」是兩個不同的答案
 * (實測 Lemon:依中繼資料挑到的是羅馬拼音版,依內容挑到的才是畫面上那一份日文)。
 * 共用同一格會使先到的那一種佔住快取,另一種在七天內都拿到錯的版本。
 *
 * 只需要「是否為同一份參考歌詞」,故存雜湊而非整份文字 —— 快取的體積不該隨歌詞長度增長。
 */
function referenceKey(lines) {
  if (!lines?.length) return null;
  const text = lines.join('\n');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${hash.toString(36)}`;
}

/**
 * 讀取快取。除版本與有效期外,尚須確認該筆是否以相同的曲目長度挑選而得。
 *
 * 長度須納入判斷的原因:同一首歌在 LRCLIB 常有數個版本(單曲版、專輯版、Live),
 * 長度差異大且時間軸完全不通用。pick-lyrics.js 以曲目長度篩除非同一版本的結果,
 * 因此「以長度 245 挑出的結果」與「未經篩選挑出的結果」是兩個不同的答案,
 * 不可共用同一格快取。
 *
 * 三種情形:
 * - 呼叫端未提供長度 → 無偏好,任何已存內容皆可接受
 * - 提供長度且與當初一致 → 命中
 * - 提供長度但當初非以其挑選 → 視為未命中,重新取得以挑出正確版本
 */
async function readCache(key, durationSec, refKey) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;

  if (entry.v !== CACHE_VERSION || Date.now() - entry.savedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }

  if (durationSec && entry.pickedFor !== durationSec) return null;
  // 參考歌詞不同(或一方有、一方沒有)即為不同的答案,不可共用(見 referenceKey)
  if ((entry.ref ?? null) !== (refKey ?? null)) return null;

  return {
    lines: entry.lines,
    synced: entry.synced ?? null,
    times: entry.times ?? null,
    coverage: entry.coverage ?? 0,
    pickedBy: entry.pickedBy ?? 'metadata',
  };
}

async function writeCache(key, payload, durationSec, refKey) {
  await chrome.storage.local.set({
    [key]: {
      v: CACHE_VERSION,
      ...payload,
      pickedFor: durationSec ?? null,
      ref: refKey ?? null,
      savedAt: Date.now(),
    },
  });
}

/**
 * 向 LRCLIB 送出一次搜尋。只負責取得結果,挑選交由 pick-lyrics.js。
 *
 * @param {Record<string, string>} params 查詢參數(track_name,artist_name 為選填)
 * @returns {Promise<Array<object>|null>} 請求失敗或回應非 JSON 時回 null
 */
async function searchLrclib(params) {
  const url = `${LRCLIB_ENDPOINT}?${new URLSearchParams(params)}`;

  // 未設逾時的 fetch 可能持續等待,導致 service worker 遭回收時
  // 訊息通道無聲關閉(即 "message channel closed" 警告的來源之一)
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      // LRCLIB 官方建議以自訂 client 標頭標明身分
      headers: { 'Lrclib-Client': CLIENT_HEADER },
      signal: controller.signal,
    });

    if (!res.ok) {
      // 以 Node 測試時此處會取得 403 與 HTML 內容(Cloudflare 阻擋自動化流量)。
      // 由 Chrome 擴充功能發出的請求帶有真實瀏覽器指紋,預期不會被阻擋。
      const hint = res.status === 403 ? '(可能被 Cloudflare 擋下)' : '';
      console.warn(`${LOG} LRCLIB 查詢失敗,狀態碼: ${res.status} ${hint}`);
      return null;
    }

    // 遭阻擋時可能回應 200 與挑戰頁面,故先確認內容型別確為 JSON 再解析
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      console.warn(`${LOG} LRCLIB 回傳的不是 JSON(content-type: ${contentType}),可能是 Cloudflare 挑戰頁`);
      return null;
    }

    const results = await res.json();
    return Array.isArray(results) ? results : null;
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
 * 查詢並挑出要用的那一筆。
 *
 * 有參考歌詞卻挑不到內容相符的版本時,改以曲名再查一次。
 * 實測(2026-09)的必要性:YouTube Music 顯示的歌手名可能是英文或翻譯名
 * (Kenshi Yonezu、愛繆、Remioromen),該名稱下的 LRCLIB 條目可能全是羅馬拼音版
 * 或根本查不到;曲名通常仍為原文。Lemon 以曲名重查後相符度為 99%。
 *
 * 只在「有參考歌詞」時重查:沒有參考歌詞就無從判斷重查的結果是否更好,
 * 多送一次請求只是增加別人的負擔。
 */
async function resolveLyrics(trackName, artistName, durationSec, referenceLines) {
  const results = await searchLrclib({ track_name: trackName, artist_name: artistName });
  let picked = pickLyrics(results, { durationSec, referenceLines });

  if (referenceLines?.length && picked?.pickedBy !== 'content') {
    const byTitle = await searchLrclib({ track_name: trackName });
    const retry = pickLyrics(byTitle, { durationSec, referenceLines });
    // 僅在重查確實對上內容時才採用;否則維持原本那一筆(至少歌名與歌手是對的)
    if (retry?.pickedBy === 'content' || !picked) picked = retry ?? picked;
  }

  return toPayload(picked);
}

/**
 * 對外主要入口:先查快取,未命中才呼叫 API。
 * 同時掛於 globalThis,便於在 service worker 的 DevTools 手動測試:
 *   await fetchLyrics('曲名', '歌手名')
 *
 * @param {string[]} [referenceLines] 畫面上已顯示的歌詞行(YouTube Music)。
 *        提供時改以內容挑選版本,並回傳與這些行一一對應的時間 times。
 * @returns {Promise<{lines: string[]|null, synced: string|null, cached: boolean,
 *                    times?: Array<number|null>|null, coverage?: number, pickedBy?: string}>}
 */
async function fetchLyrics(trackName, artistName, durationSec, referenceLines) {
  const refKey = referenceKey(referenceLines);

  /*
   * 回應的形狀依有無參考歌詞而不同。
   *
   * 沒有參考歌詞時(Spotify 的備援)刻意維持原本的三個欄位,一個不多:
   * 那條路徑已在使用中,多出來的欄位對它毫無意義,而「回應完全相同」
   * 才能以快照逐欄位比對確認這次改動沒有波及它。
   */
  const shape = (payload, cached) =>
    referenceLines?.length
      ? {
          lines: payload?.lines ?? null,
          synced: payload?.synced ?? null,
          times: payload?.times ?? null,
          coverage: payload?.coverage ?? 0,
          pickedBy: payload?.pickedBy ?? null,
          cached,
        }
      : { lines: payload?.lines ?? null, synced: payload?.synced ?? null, cached };

  if (!trackName || !artistName) return shape(null, false);

  const key = cacheKey(trackName, artistName);

  const cached = await readCache(key, durationSec, refKey);
  if (cached) {
    console.info(`${LOG} 命中快取: ${key}`);
    return shape(cached, true);
  }

  // 同時進入的兩個請求若帶有不同的長度或不同的參考歌詞,結果亦不同,不可共用同一個 Promise
  const flightKey = `${key}|${durationSec ?? ''}|${refKey ?? ''}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);

  const task = (async () => {
    const result = await resolveLyrics(trackName, artistName, durationSec, referenceLines);
    if (result) await writeCache(key, result, durationSec, refKey);
    else console.info(`${LOG} 找不到「${trackName}」的歌詞`);
    return shape(result, false);
  })().finally(() => inFlight.delete(flightKey));

  inFlight.set(flightKey, task);
  return task;
}

globalThis.fetchLyrics = fetchLyrics;

/* ------------------------------------------------------- 共用讀音字典 */

/*
 * 字典置於 GitHub 上的一個公開檔案,由擴充功能定期取得。
 *
 * 採此作法而非自建伺服器的理由:
 * - 無需費用與維運,由 GitHub 代管
 * - 僅維護者可修改,品質仍有人把關 —— 此點至關重要,
 *   錯誤的讀音會使畫面以確信的樣態顯示錯誤的拼音,較轉換失敗更難察覺
 * - 修改後毋須發布新版,合併後數小時內所有使用者皆可取得
 * - 僅有 GET、不送出任何資料,「本擴充功能沒有伺服器」的敘述仍然成立
 */
const DICTIONARY_URL =
  'https://raw.githubusercontent.com/psgo555/romaji-lyrics-extension/master/dictionary.json';
const DICTIONARY_KEY = 'sharedDictionary';
const DICTIONARY_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時
// 2:新增限定單曲的條目(songs)。舊快取無該欄位,推進版本號以強制重新取得。
const DICTIONARY_CACHE_VERSION = 2;

/*
 * 安裝、更新,以及開發時按下「重新載入擴充功能」皆會清除快取,下一次即重新取得。
 *
 * 必要性:12 小時的快取對一般使用者合宜,但對剛修改完字典的人完全不合直覺 ——
 * 檔案已改、擴充功能已重新載入,畫面卻沒有變化,且無任何跡象指向快取。
 * 此情形已實際發生過一次。
 *
 * 重新載入本身即代表「要看到最新狀態」,快取不應存續於該動作之後。
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(DICTIONARY_KEY).catch(() => {});
});

/**
 * 取得共用字典。先查快取,過期才連網。
 *
 * 任何一步失敗皆回傳空陣列而非拋出例外 —— 取不到字典僅代表少了若干新詞,
 * 內建字典仍在,不應使整個轉換流程一併失效。
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
      return fromCache(cached); // 過期的資料仍優於全無
    }

    const { entries, songs, skipped } = parseSharedDictionary(await res.json());
    if (skipped) {
      console.warn(`${LOG} 共用字典有 ${skipped} 筆沒通過驗證,已略過`);
    }

    /*
     * 驗證後為空時不覆蓋快取。
     *
     * 該情形代表檔案損壞或格式變更。此時寫入空資料等同於一併清除使用者
     * 原本仍可使用的那一份 —— 一人誤改檔案,所有使用者的字典即為空。
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
 * 將快取整理成回應的形狀。
 *
 * 抽出的原因:「取不到即沿用舊資料」在上方出現四處,而每一處都須同時帶上
 * entries 與 songs —— 遺漏其一的症狀是限定單曲的修正在未連上網時無聲失效,
 * 不會產生任何錯誤訊息。
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
  // 非本模組的訊息回傳 false,將通道讓予其他 listener,不佔用而不回應
  if (message?.type !== 'FETCH_LYRICS') return false;

  // 回應恰好一次。
  // 少回應 → console 出現 "message channel closed before a response was received";
  // 多回應 → 第二次呼叫 sendResponse 會拋出例外。
  let answered = false;
  const respond = (payload) => {
    if (answered) return;
    answered = true;
    try {
      sendResponse(payload);
    } catch (err) {
      // 發送端(分頁)可能已關閉或重新整理,此時回應失敗屬正常情形
      console.warn(`${LOG} 回應訊息失敗,發送端可能已關閉:`, err);
    }
  };

  // 保險絲:service worker 有存活上限,若 fetch 卡住,通道會無聲關閉
  // 並於 content script 端產生警告。此處寧可先回傳一個明確的逾時結果。
  const fuse = setTimeout(() => {
    console.warn(`${LOG} FETCH_LYRICS 逾時,先回空結果`);
    respond({ lines: null, synced: null, cached: false, timedOut: true });
  }, RESPONSE_TIMEOUT_MS);

  fetchLyrics(message.trackName, message.artistName, message.durationSec, message.lines)
    .then((result) => respond(result))
    .catch((err) => {
      console.error(`${LOG} 處理 FETCH_LYRICS 失敗:`, err);
      respond({ lines: null, synced: null, cached: false });
    })
    .finally(() => clearTimeout(fuse));

  return true; // 維持非同步回應通道
}
