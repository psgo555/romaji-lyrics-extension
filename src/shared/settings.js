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
   * 掃描提前量(毫秒)。正值 = 提早掃。
   *
   * ── 預設為什麼是 0 ────────────────────────────────────────
   * 這個值原本預設 900,用來補「LRCLIB 的時間軸跟 Spotify 差一截」。
   * 那個時間差現在改成每次換句重新對錶(見 content/line-anchor.js),
   * 不需要靠它補了。
   *
   * 而且對錶之後這個值的意義變了:換句的時機由 Spotify 決定,提前量
   * 只會讓掃描**在句子內部**跑在前面 —— 設 900 的話,每句一開始
   * 掃描就已經在兩三成的位置上,換句時看得到一下突跳。
   *
   * 留著這個設定是因為「字要比聲音早一點出來」確實是跟唱的人要的
   * (卡拉OK 本來就會提前給詞),而早多少因人而異。只是那應該是
   * 使用者自己加上去的偏好,不是我們預設就欠他一截。
   */
  syncOffsetMs: 0,

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

  /**
   * 拼音的顏色(六位十六進位色碼)。
   *
   * 為什麼做成可調而不是我選一個好看的:這件事沒有正確答案 ——
   * 專輯封面的顏色一直在變、每個人對比敏感度不同、有人就是不喜歡綠的。
   * 預設用 Spotify 綠是為了跟頁面一致,但那只是個起點。
   */
  romajiColor: '#1db954',

  /**
   * 拼音相對於原文的大小(百分比)。
   *
   * 不懂假名的人主要在看拼音,把它縮小其實是反過來的;
   * 但看得懂一些的人又希望原文為主。所以這也交給使用者。
   */
  romajiScale: 80,
};

/** 顏色只接受六位十六進位色碼 */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * 把顏色正規化。認不得的一律退回預設。
 *
 * **這道檢查不能省**:這個值會被寫進頁面的 CSS 變數。雖然 setProperty
 * 不會執行程式碼,但放行任意字串等於讓儲存裡的內容直接影響頁面樣式 ——
 * 而那份儲存是跨裝置同步的,不是只有本機。嚴格比對格式,不合就當沒設定。
 */
export function normalizeColor(value) {
  return COLOR_PATTERN.test(value ?? '') ? value.toLowerCase() : DEFAULTS.romajiColor;
}

/** 拼音大小的合理範圍。太小看不清,太大會把原文擠掉 */
export const ROMAJI_SCALE_MIN = 60;
export const ROMAJI_SCALE_MAX = 120;

export function normalizeScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.romajiScale;
  return Math.min(ROMAJI_SCALE_MAX, Math.max(ROMAJI_SCALE_MIN, Math.round(number)));
}

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

/*
 * 提前量的合理範圍與刻度,超出多半是誤操作。
 *
 * popup 的滑桿**不要**自己在 HTML 裡寫一次 min/max/step —— 那樣同一組數字
 * 會有兩份,改了其中一邊就會出現「滑桿拉得到 3000、存進去卻被砍回 2000,
 * 畫面顯示跟實際生效不一致」而且完全不噴錯。
 * popup.js 啟動時會拿這三個值去設定滑桿。
 */
export const SYNC_OFFSET_MIN = -500;
export const SYNC_OFFSET_MAX = 2000;
export const SYNC_OFFSET_STEP = 50;

/** 掃描速度的合理範圍。太小會整句瞬間掃完,太大則永遠掃不到句尾 */
export const SWEEP_MS_MIN = 60;
export const SWEEP_MS_MAX = 320;

export function normalizeSweepMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.sweepMsPerLetter;
  return Math.min(SWEEP_MS_MAX, Math.max(SWEEP_MS_MIN, Math.round(number)));
}

/**
 * 把提前量講成人話。
 *
 * 內部一律用毫秒(時間計算需要),但**不要讓使用者讀毫秒** ——
 * 「+900 ms」得先在腦裡除以一千才知道是多久,而且正負號還要另外理解。
 * 「提早 0.9 秒」不必翻譯,看到就懂。
 *
 * 放在這裡而不是 popup.js:正負號代表提早還是延後,是這個設定的**定義**
 * 的一部分。哪天有別的地方要顯示它,不該再自己解讀一次而弄反。
 *
 * @param {number} ms 已經正規化過的毫秒值
 */
export function describeOffset(ms) {
  const value = normalizeOffset(ms);
  if (value === 0) return '不調整';

  // 刻度是 50ms,所以最多兩位小數;把尾巴的零去掉,0.90 顯示成 0.9
  const seconds = (Math.abs(value) / 1000).toFixed(2).replace(/\.?0+$/, '');
  return value > 0 ? `提早 ${seconds} 秒` : `延後 ${seconds} 秒`;
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
  { value: 'romaji-only', label: '純羅馬拼音', short: '拼' },
  { value: 'both', label: '日 + 羅馬拼音', short: '拼日' },
  { value: 'kana', label: '日 + 平假名', short: '假名' },
  { value: 'off', label: '關閉', short: '關' },
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
    romajiColor: normalizeColor(stored.romajiColor),
    romajiScale: normalizeScale(stored.romajiScale),
  };
}

/** 寫入單一設定值 */
export async function setSetting(key, value) {
  await chrome.storage.sync.set({ [key]: value });
}
