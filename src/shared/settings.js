/**
 * settings.js
 * content script 與 popup 共用的設定讀寫層。
 * 預設值僅存在此處一份,避免兩端各寫一份而不一致。
 */

export const DEFAULTS = {
  /**
   * 'romaji-only' 僅顯示羅馬拼音,隱藏原文(預設)
   * 'both'        原文與其下方的羅馬拼音
   * 'kana'        原文與其下方的平假名讀音(供看得懂假名、僅卡在漢字者使用)
   * 'off'         僅顯示原文日文,完全不做轉換
   */
  displayMode: 'romaji-only',

  /**
   * 高亮提前量(毫秒)。正值代表提早顯示。
   *
   * 做成可調的原因:數種延遲會相互疊加,且因人因機而異 ——
   * Spotify 顯示的秒數本身即落後真實音訊、系統音訊輸出有緩衝,
   * 而跟唱者尚須先看到字才唱得出來(卡拉 OK 本就會提前給詞)。
   * 這些加總後不存在一個放諸四海皆準的值,故交由使用者自行對準。
   *
   * ── 預設值由 900 改為 0 的原因 ────────────────────────────
   * 900 是推測而得的值,且方向可能相反:實際回報為「高亮有點快」,
   * 亦即它本就跑在前面,再預設提早 0.9 秒只會更早。
   * LRCLIB 的時間軸與 Spotify 的絕對時間本就存在落差,該落差每首歌
   * 皆不相同,並非一個常數所能補償 —— 故預設不補,交由滑桿處理。
   */
  syncOffsetMs: 0,

  /**
   * 逐字掃描時,每個字母至多值得掃描多少毫秒。
   *
   * 僅在該首歌沒有逐字時間軸時才會用到 —— 具備逐字資料時一律採用真實資料,
   * 此值完全不參與。其用途是限制估算的誤差幅度:句尾接長間奏時
   * 句距遠大於實際演唱長度,依句距掃描會拖成「整句唱完才掃到四分之一」,
   * 此時改由字數封頂。
   *
   * 可調而非寫死的原因:合適的值取決於該首歌的演唱速度,
   * 而那是每首歌皆不相同的。與 syncOffsetMs 同理,與其反覆推測一個
   * 通用的數字,不如讓使用者一邊播放一邊拖曳至看起來正確為止。
   */
  sweepMsPerLetter: 180,

  /**
   * 拼音的顏色(六位十六進位色碼)。
   *
   * 做成可調而非逕自指定一個好看的顏色:此事沒有正確答案 ——
   * 專輯封面的顏色持續在變、每個人的對比敏感度不同,亦有人不喜歡綠色。
   * 預設採 Spotify 綠是為與頁面一致,但那僅是一個起點。
   */
  romajiColor: '#1db954',

  /**
   * 拼音相對於原文的大小(百分比)。
   *
   * 不懂假名者主要在看拼音,將其縮小其實是反過來的;
   * 但看得懂一些的人又希望以原文為主。故此項同樣交由使用者決定。
   */
  romajiScale: 80,
};

/** 顏色僅接受六位十六進位色碼 */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * 將顏色正規化。無法辨識者一律退回預設。
 *
 * 這道檢查不可省略:該值會被寫入頁面的 CSS 變數。雖然 setProperty
 * 不會執行程式碼,但放行任意字串等同於讓儲存的內容直接影響頁面樣式 ——
 * 而該份儲存是跨裝置同步的,不限於本機。嚴格比對格式,不符即視為未設定。
 */
export function normalizeColor(value) {
  return COLOR_PATTERN.test(value ?? '') ? value.toLowerCase() : DEFAULTS.romajiColor;
}

/** 拼音大小的合理範圍。過小難以辨識,過大則會擠掉原文 */
export const ROMAJI_SCALE_MIN = 60;
export const ROMAJI_SCALE_MAX = 120;

export function normalizeScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.romajiScale;
  return Math.min(ROMAJI_SCALE_MAX, Math.max(ROMAJI_SCALE_MIN, Math.round(number)));
}

/*
 * ── 未提供「掃描快慢」設定的原因 ──────────────────────────────
 *
 * 曾加入一個倍率讓使用者調整逐字掃描的快慢,完成後隨即移除 ——
 * 因為該項不論往哪個方向調整都是錯的:
 *
 *   調快 → 字已掃到底,該句仍在演唱,掃描只能停在句尾等待
 *   調慢 → 該句唱完即將換行,字才掃到一半,直接被截斷
 *
 * 根本原因是「一句唱多久」由歌曲本身決定,並非可調整之事。
 * 掃描的正確行為只有一種:該句開始時從頭,該句結束時恰好到底。
 *
 * 使用者覺得「太快」時,真正的成因是整體時間差(音訊緩衝、
 * 顯示延遲、看到字到唱出來的反應時間)—— 而那正是 syncOffsetMs
 * 所解決的,它會使整句與逐字一併平移,不致拆散兩者的關係。
 *
 * 結論:可調的只有「早或晚」,不應有「快或慢」。
 */

/*
 * 提前量的合理範圍與刻度,超出者多為誤操作。
 *
 * popup 的滑桿不應自行在 HTML 中另寫一次 min/max/step —— 那會使同一組數字
 * 存在兩份,修改其中一邊即出現「滑桿拉得到 3000、存入卻被砍回 2000,
 * 畫面顯示與實際生效不一致」的情形,且完全不會產生錯誤。
 * popup.js 啟動時會取這三個值來設定滑桿。
 */
export const SYNC_OFFSET_MIN = -500;
export const SYNC_OFFSET_MAX = 2000;
export const SYNC_OFFSET_STEP = 50;

/** 掃描速度的合理範圍。過小會整句瞬間掃完,過大則永遠掃不到句尾 */
export const SWEEP_MS_MIN = 60;
export const SWEEP_MS_MAX = 320;

export function normalizeSweepMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.sweepMsPerLetter;
  return Math.min(SWEEP_MS_MAX, Math.max(SWEEP_MS_MIN, Math.round(number)));
}

/**
 * 將提前量表述為人類可讀的說法。
 *
 * 內部一律以毫秒為單位(時間計算需要),但不應讓使用者讀毫秒 ——
 * 「+900 ms」須先在腦中除以一千才知道是多久,且正負號還要另外理解。
 * 「提早 0.9 秒」毋須翻譯,看到即懂。
 *
 * 置於此處而非 popup.js:正負號代表提早或延後,是這項設定定義的一部分。
 * 日後若有其他地方要顯示它,不應再自行解讀一次而弄反。
 *
 * @param {number} ms 已正規化的毫秒值
 */
export function describeOffset(ms) {
  const value = normalizeOffset(ms);
  if (value === 0) return '不調整';

  // 刻度為 50ms,故至多兩位小數;去除尾端的零,0.90 顯示為 0.9
  const seconds = (Math.abs(value) / 1000).toFixed(2).replace(/\.?0+$/, '');
  return value > 0 ? `提早 ${seconds} 秒` : `延後 ${seconds} 秒`;
}

/** 將提前量夾在合理範圍內;無法辨識的值退回預設 */
export function normalizeOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.syncOffsetMs;
  return Math.min(SYNC_OFFSET_MAX, Math.max(SYNC_OFFSET_MIN, Math.round(number)));
}

/**
 * 四種顯示方式。順序即頁面上那顆切換鈕的循環順序。
 * short 是按鈕上顯示的縮寫,popup 則使用 label。
 */
export const DISPLAY_MODES = [
  { value: 'romaji-only', label: '純羅馬拼音', short: '拼' },
  { value: 'both', label: '日 + 羅馬拼音', short: '拼日' },
  { value: 'kana', label: '日 + 平假名', short: '假名' },
  { value: 'off', label: '關閉', short: '關' },
];

const VALID_MODES = new Set(DISPLAY_MODES.map((mode) => mode.value));

/** 無法辨識的值(例如早期版本的 'below'、'above')一律退回預設 */
export function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : DEFAULTS.displayMode;
}

/** 取得某個模式的顯示資訊(label / short) */
export function describeMode(value) {
  const mode = normalizeMode(value);
  return DISPLAY_MODES.find((m) => m.value === mode);
}

/**
 * 循環順序中的下一個模式:
 * romaji-only → both → kana → off → romaji-only
 *
 * 順序即 DISPLAY_MODES 的排列,不應在此另寫一份清單 ——
 * 先前這一行漏掉了後來才加入的 kana,列了三個而實際有四個。
 * 新增模式時只需修改 DISPLAY_MODES,本函式毋須更動。
 */
export function nextMode(value) {
  const index = DISPLAY_MODES.findIndex((m) => m.value === normalizeMode(value));
  return DISPLAY_MODES[(index + 1) % DISPLAY_MODES.length].value;
}

/** displayMode 是否關閉了整個轉換功能 */
export function isConversionOff(displayMode) {
  return displayMode === 'off';
}

/**
 * 該模式所需的轉換種類。
 *
 * 獨立成一個概念的原因:romaji-only 與 both 的差別純粹在 CSS,
 * 切換時完全毋須重新轉換。但 kana 不同 —— 它需要的是另一份文字,
 * 非重轉不可。呼叫端以本函式的回傳值比對,即不致將
 * 「更換顯示方式」誤判為「須重跑一次全部的斷詞」(那會卡住整個頁面)。
 *
 * @returns {'romaji'|'kana'|null} null 代表該模式不做任何轉換
 */
export function conversionKind(displayMode) {
  const mode = normalizeMode(displayMode);
  if (mode === 'off') return null;
  return mode === 'kana' ? 'kana' : 'romaji';
}

/** 讀取設定,缺少的欄位以預設值補上;無法辨識的舊值同樣退回預設 */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    displayMode: normalizeMode(stored.displayMode),
    syncOffsetMs: normalizeOffset(stored.syncOffsetMs),
    sweepMsPerLetter: normalizeSweepMs(stored.sweepMsPerLetter),
    romajiColor: normalizeColor(stored.romajiColor),
    romajiScale: normalizeScale(stored.romajiScale),
  };
}

/** 寫入單一設定值 */
export async function setSetting(key, value) {
  await chrome.storage.sync.set({ [key]: value });
}
