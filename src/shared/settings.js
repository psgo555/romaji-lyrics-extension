/**
 * settings.js
 * content script 與 popup 共用的設定讀寫層。
 * 預設值只寫在這裡一份,避免兩邊各寫一份導致不一致。
 */

export const DEFAULTS = {
  /**
   * 'romaji-only' 只顯示羅馬拼音,隱藏原文(預設)
   * 'both'        原文 + 下方羅馬拼音
   * 'kana'        原文 + 下方平假名讀音(給看得懂假名、只卡在漢字的人)
   * 'off'         只顯示原文日文,完全不做轉換
   */
  displayMode: 'romaji-only',

  /**
   * 高亮提前量(毫秒)。正值 = 提早亮。
   *
   * 為什麼要做成可調:好幾個延遲會疊加起來,而且每個人、每台機器不一樣 ——
   * Spotify 顯示的秒數本身就落後真實音訊、系統音訊輸出有緩衝,
   * 而跟唱的人還需要先看到字才唱得出來(卡拉OK 本來就會提前給詞)。
   * 這些加起來沒有一個放諸四海皆準的值,所以交給使用者自己對到準為止。
   */
  syncOffsetMs: 900,

  /**
   * 逐字掃描時,每個字母最多值得掃多少毫秒。
   *
   * 只有在**這首歌沒有逐字時間軸**時才會用到 —— 有逐字資料就走真資料,
   * 這個值完全不參與。它的用途是限制估算出錯的幅度:句尾接長間奏時
   * 句距遠大於實際演唱長度,照句距掃會拖成「整句唱完才掃到四分之一」,
   * 這時改由字數封頂。
   *
   * 為什麼可調而不是寫死:合適的值取決於這首歌唱得多快,
   * 而那是每首歌都不一樣的。跟 syncOffsetMs 一樣,與其反覆猜一個
   * 放諸四海皆準的數字,不如讓使用者一邊播一邊拖到看起來對為止。
   */
  sweepMsPerLetter: 180,
};

/*
 * ── 為什麼沒有「掃描快慢」這個設定 ────────────────────────────
 *
 * 曾經加過一個倍率讓使用者調逐字掃描的快慢,做完就拿掉了 ——
 * 因為那個東西**不管往哪調都是錯的**:
 *
 *   調快 → 字掃到底了,這句還在唱,掃描只能停在句尾乾等
 *   調慢 → 這句唱完要換行了,字才掃到一半,直接被截斷
 *
 * 根本原因是「一句唱多久」由歌本身決定,不是可以調整的東西。
 * 掃描的正確行為只有一種:這句開始時從頭,這句結束時剛好到底。
 *
 * 使用者覺得「太快」時,真正的原因是**整體時間差**(音訊緩衝、
 * 顯示延遲、看到字到唱出來的反應時間)—— 而那正是 syncOffsetMs
 * 在解決的,它會讓整句與逐字**一起**平移,不會拆散兩者的關係。
 *
 * 所以:能調的只有「早或晚」,不該有「快或慢」。
 */

/** 提前量的合理範圍,超出多半是誤操作 */
export const SYNC_OFFSET_MIN = -500;
export const SYNC_OFFSET_MAX = 2000;

/** 掃描速度的合理範圍。太小會整句瞬間掃完,太大則永遠掃不到句尾 */
export const SWEEP_MS_MIN = 60;
export const SWEEP_MS_MAX = 320;

export function normalizeSweepMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.sweepMsPerLetter;
  return Math.min(SWEEP_MS_MAX, Math.max(SWEEP_MS_MIN, Math.round(number)));
}

/** 把提前量夾在合理範圍內;認不得的值退回預設 */
export function normalizeOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.syncOffsetMs;
  return Math.min(SYNC_OFFSET_MAX, Math.max(SYNC_OFFSET_MIN, Math.round(number)));
}

/**
 * 三種顯示方式。順序就是頁面上那顆切換鈕的循環順序。
 * short 是按鈕上顯示的縮寫,popup 用 label + hint。
 */
export const DISPLAY_MODES = [
  { value: 'romaji-only', label: '純羅馬拼音', hint: '隱藏原文,只顯示拼音', short: '拼' },
  { value: 'both', label: '原文 + 下方羅馬拼音', hint: '兩者都顯示', short: '拼日' },
  { value: 'kana', label: '原文 + 平假名讀音', hint: '只把漢字的讀音標出來', short: '假名' },
  { value: 'off', label: '關閉', hint: '只顯示原文日文,不做轉換', short: '關' },
];

const VALID_MODES = new Set(DISPLAY_MODES.map((mode) => mode.value));

/** 認不得的值(例如早期版本的 'below'、'above')一律退回預設 */
export function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : DEFAULTS.displayMode;
}

/** 取得某個模式的顯示資訊(label / hint / short) */
export function describeMode(value) {
  const mode = normalizeMode(value);
  return DISPLAY_MODES.find((m) => m.value === mode);
}

/**
 * 循環順序中的下一個模式:
 * romaji-only → both → kana → off → romaji-only
 *
 * 順序就是 DISPLAY_MODES 的排列,不要在這裡另外寫死一份清單 ——
 * 先前這行漏掉了後來才加的 kana,列了三個而實際有四個。
 * 加新模式時只要動 DISPLAY_MODES,這支函式不必改。
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
 * 這個模式要跑哪一種轉換。
 *
 * 為什麼要獨立成一個概念:romaji-only 與 both 的差別**純粹是 CSS**,
 * 切換時完全不必重新轉換。但 kana 不一樣 —— 它要的是另一份文字,
 * 非重轉不可。呼叫端拿這個函式的回傳值去比,就不會把
 * 「換個顯示方式」誤判成「要重跑一次全部的斷詞」(那會卡住整個頁面)。
 *
 * @returns {'romaji'|'kana'|null} null 代表這個模式不做任何轉換
 */
export function conversionKind(displayMode) {
  const mode = normalizeMode(displayMode);
  if (mode === 'off') return null;
  return mode === 'kana' ? 'kana' : 'romaji';
}

/** 讀取設定,缺的欄位用預設值補上;認不得的舊值也退回預設 */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    displayMode: normalizeMode(stored.displayMode),
    syncOffsetMs: normalizeOffset(stored.syncOffsetMs),
    sweepMsPerLetter: normalizeSweepMs(stored.sweepMsPerLetter),
  };
}

/** 寫入單一設定值 */
export async function setSetting(key, value) {
  await chrome.storage.sync.set({ [key]: value });
}
