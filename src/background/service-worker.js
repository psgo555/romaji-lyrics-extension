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
 * 日文判定沿用 content script 的實作。
 *
 * 不於此另寫一份正規表達式:cjk.js 涵蓋的範圍廣得多(疊字符、半形片假名、
 * 擴充漢字區),同一項判斷若存在兩份實作,終將出現一邊修改而另一邊未同步的情形
 * —— 本專案已於「長音符」與「曲目長度」各發生過一次。
 *
 * cjk.js 不 import 任何模組,亦不觸及畫面與擴充功能介面,背景程式可安全引用。
 */
import { hasJapanese } from '../content/cjk.js';
import { parseSharedDictionary } from '../shared/shared-dictionary.js';

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
 */
const CACHE_VERSION = 3;

/**
 * 讀取快取。除版本與有效期外,尚須確認該筆是否以相同的曲目長度挑選而得。
 *
 * 長度須納入判斷的原因:同一首歌在 LRCLIB 常有數個版本(單曲版、專輯版、Live),
 * 長度差異大且時間軸完全不通用。requestLrclib 以曲目長度篩除非同一版本的結果,
 * 因此「以長度 245 挑出的結果」與「未經篩選挑出的結果」是兩個不同的答案,
 * 不可共用同一格快取。
 *
 * 三種情形:
 * - 呼叫端未提供長度 → 無偏好,任何已存內容皆可接受
 * - 提供長度且與當初一致 → 命中
 * - 提供長度但當初非以其挑選 → 視為未命中,重新取得以挑出正確版本
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
 * 該筆歌詞中含日文的行數比例(0~1)。
 *
 * 以「行」而非「字」為單位,是因為所要分辨的正是對照版:
 * 其日文一句不少,僅在每句後方插入一句翻譯。按字數計算會沖淡兩者的差距,
 * 按行計算則為 54% 對 95% 的明確差異。
 *
 * 開頭數行製作資訊(作詞、作曲)一併計入 —— 其中含歌手名的漢字,
 * 兩種版本皆有,對比較結果無影響,不值得為此另寫排除邏輯。
 */
function japaneseRatio(entry) {
  const text = entry?.syncedLyrics || entry?.plainLyrics || '';
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return 0;
  return lines.filter((line) => hasJapanese(line)).length / lines.length;
}

/**
 * 以歌名與歌手名向 LRCLIB 搜尋歌詞。
 * @returns {Promise<{lines: string[]|null, synced: string|null}|null>}
 *          挑選後的最佳結果;查無結果或請求失敗時回傳 null
 */
async function requestLrclib(trackName, artistName, durationSec) {
  const url = `${LRCLIB_ENDPOINT}?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;

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
    if (!Array.isArray(results) || results.length === 0) return null;

    const usable = results.filter((r) => r?.plainLyrics || r?.syncedLyrics);
    if (!usable.length) return null;

    // 同一首歌常有多個版本(單曲版、專輯版、Live),長度差異大者時間軸完全對不上。
    // 先以歌曲長度篩除明顯不屬同一版本的結果。
    const sameLength = durationSec
      ? usable.filter((r) => Math.abs((r.duration ?? 0) - durationSec) <= 3)
      : [];
    const pool = sameLength.length ? sameLength : usable;

    /*
     * 其餘結果依兩項條件排序,取最佳者。
     *
     * 1. 有時間軸者優先 —— 逐句同步僅在具備時間軸時成立,價值最高
     * 2. 同樣有時間軸時,取日文比例最高者
     *
     * 第 2 點源自實測(Lemon,LRCLIB 回傳 20 筆):
     * 內容由使用者上傳,同一首歌會混雜「純日文版」與「日文 + 外語對照版」。
     * 對照版每句寫兩遍且時間標記相同,日文僅佔 54%;純日文版為 95%。
     *
     * 挑到對照版的後果:歌詞面板每句印兩遍,且因兩行時間相同、
     * activeIndexAt 取的是最後一個符合者,高亮會停在翻譯那一行。
     *
     * 採「比例最高」而非「必須含日文」的原因:
     * 使用者亦聽中文與英文歌,該類歌曲本就不含日文。硬性條件會使其
     * 由「有歌詞」變為「完全沒有歌詞」,等於為修正一種情況而破壞另一種。
     * 改以排序則無此問題:全數不含日文時分數相同,順序不變,
     * 行為與改動前完全一致。
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
 * 對外主要入口:先查快取,未命中才呼叫 API。
 * 同時掛於 globalThis,便於在 service worker 的 DevTools 手動測試:
 *   await fetchLyrics('曲名', '歌手名')
 * @returns {Promise<{lines: string[]|null, synced: string|null, cached: boolean}>}
 */
async function fetchLyrics(trackName, artistName, durationSec) {
  if (!trackName || !artistName) return { lines: null, synced: null, cached: false };

  const key = cacheKey(trackName, artistName);

  const cached = await readCache(key, durationSec);
  if (cached) {
    console.info(`${LOG} 命中快取: ${key}`);
    return { ...cached, cached: true };
  }

  // 同時進入的兩個請求若帶有不同的長度,結果亦不同,不可共用同一個 Promise
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

  fetchLyrics(message.trackName, message.artistName, message.durationSec)
    .then((result) => respond(result))
    .catch((err) => {
      console.error(`${LOG} 處理 FETCH_LYRICS 失敗:`, err);
      respond({ lines: null, synced: null, cached: false });
    })
    .finally(() => clearTimeout(fuse));

  return true; // 維持非同步回應通道
}
