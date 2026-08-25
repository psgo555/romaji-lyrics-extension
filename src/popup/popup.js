/**
 * popup.js
 * 設定介面:顯示方式、高亮提前量,以及自訂讀音的管理。
 * 寫入 chrome.storage.sync 之後,content script 透過 storage.onChanged 立即套用。
 */

import {
  getSettings,
  setSetting,
  normalizeMode,
  normalizeOffset,
  describeOffset,
  SYNC_OFFSET_MIN,
  SYNC_OFFSET_MAX,
  SYNC_OFFSET_STEP,
  normalizeColor,
  normalizeScale,
  ROMAJI_SCALE_MIN,
  ROMAJI_SCALE_MAX,
  DISPLAY_MODES,
} from '../shared/settings.js';

/*
 * corrections-store.js 位於 src/content/ 之下,但並不綁定 content script ——
 * 它只觸及 chrome.storage 與純邏輯,在 popup 中同樣可以執行。
 *
 * 寧可跨目錄匯入亦不在 popup 自寫一份的原因:該模組內含儲存格式版本、
 * 內建表與使用者表的合併規則,以及 sync 的容量上限檢查。
 * 複製一份出來,兩端遲早會對這些規則產生不同的理解 —— 而該類不一致
 * 不會產生錯誤,只會使使用者的資料無聲損壞(長音符那次即是如此)。
 */
import {
  loadUserCorrections,
  getUserCorrections,
  addUserCorrection,
  removeUserCorrection,
  isValidReading,
  onCorrectionsChanged,
} from '../content/corrections-store.js';

const modesEl = document.getElementById('modes');
const offsetEl = document.getElementById('offset');
const offsetValueEl = document.getElementById('offset-value');
const colorEl = document.getElementById('color');
const scaleEl = document.getElementById('scale');
const scaleValueEl = document.getElementById('scale-value');
const correctionsEl = document.getElementById('corrections');
const correctionsCountEl = document.getElementById('corrections-count');
const correctionsErrorEl = document.getElementById('corrections-error');

function renderModes(current) {
  modesEl.replaceChildren();

  for (const mode of DISPLAY_MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(mode.value === current));

    const label = document.createElement('span');
    label.className = 'mode-label';
    label.textContent = mode.label;

    button.append(label);
    button.addEventListener('click', async () => {
      renderModes(mode.value); // 先更新畫面,不等 storage 寫入完成
      await setSetting('displayMode', mode.value);
    });

    modesEl.appendChild(button);
  }
}

/*
 * 滑桿的範圍與刻度自 settings.js 取得,HTML 中不寫死。
 *
 * 那三個數字與 normalizeOffset 夾範圍所用的是同一組;分成兩份的話,
 * 修改 HTML 而未同步修改 settings.js 即成為「滑桿拉得到 3000,存入卻被砍回 2000」
 * —— 畫面顯示與實際生效不一致,且不會產生任何錯誤訊息。
 */
scaleEl.min = String(ROMAJI_SCALE_MIN);
scaleEl.max = String(ROMAJI_SCALE_MAX);
scaleEl.step = '5';

offsetEl.min = String(SYNC_OFFSET_MIN);
offsetEl.max = String(SYNC_OFFSET_MAX);
offsetEl.step = String(SYNC_OFFSET_STEP);

/** 內部存的是毫秒,顯示為「提早 0.9 秒」—— 使用者不讀毫秒 */
function renderOffset(value) {
  offsetEl.value = String(value);
  offsetValueEl.textContent = describeOffset(value);
}

/*
 * 拖曳過程中即更新畫面(input 事件),但寫入須節流。
 *
 * 採 input 而非 change 的原因:使用者要能一邊播放一邊拖曳,即時看出是否對得上。
 * content script 是靠 storage.onChanged 套用的。
 *
 * 寫入須節流的原因:chrome.storage.sync 有每分鐘約 120 次的寫入上限,
 * 超過之後接下來所有寫入都會失敗 —— 包含其他功能。而滑桿拖曳一次會連發
 * 數十個 input 事件,數秒鐘即可耗盡額度,此後使用者儲存自訂讀音便會莫名失敗。
 * (實際發生過:拖曳滑桿調整之後,補讀音按下儲存沒有反應。)
 * 該陷阱在自訂讀音的輸入框已避開(該處用 change 而非 input),滑桿當初漏掉。
 *
 * 畫面立即更新、僅寫入延後 —— 拖曳時仍即時看得到數字,停手 250ms 才真正寫入。
 * content script 既然是靠 storage.onChanged 套用,實際效果會慢那一瞬,
 * 對「一邊播放一邊對準」完全沒有影響。
 */
const WRITE_DEBOUNCE_MS = 250;
let offsetWriteTimer = null;

function saveOffsetSoon(value) {
  clearTimeout(offsetWriteTimer);
  offsetWriteTimer = setTimeout(() => {
    setSetting('syncOffsetMs', value).catch((err) =>
      console.warn('[romaji] 寫入提前量失敗:', err)
    );
  }, WRITE_DEBOUNCE_MS);
}

offsetEl.addEventListener('input', () => {
  const value = normalizeOffset(offsetEl.value);
  renderOffset(value);
  saveOffsetSoon(value);
});

/*
 * 以 0.5 秒為單位的加減按鈕。
 *
 * 於滑桿之外仍需此組按鈕的原因:滑桿一格為 50ms,要移動 0.5 秒須拉十格,
 * 而使用者實際感受到的是「早了大約半秒」這種粒度 —— 以滑桿湊很難對準。
 * 滑桿仍予保留,是因為粗調對準之後往往還想微調。
 *
 * 關鍵在於兩者調整的是同一個值:按鈕不自行記錄狀態,而是讀取目前的值加減後,
 * 走與滑桿完全相同的路徑(normalizeOffset → 畫面 → 儲存)。
 * 各自記錄一份的話兩端遲早會對不上 —— 本專案已在他處踩過此類問題。
 *
 * 夾範圍完全交由 normalizeOffset 處理,此處不重複判斷上下限。
 */
function nudgeOffset(deltaMs) {
  const value = normalizeOffset(Number(offsetEl.value) + deltaMs);
  renderOffset(value);
  // 按鈕同樣走節流:使用者可能連按數下對準,那一樣是連續寫入
  saveOffsetSoon(value);
}

for (const id of ['offset-later', 'offset-earlier']) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => nudgeOffset(Number(button.dataset.delta)));
}

/* ------------------------------------------------------------ 拼音外觀 */

/*
 * 顏色與大小與提前量走同一套節流。
 *
 * 色盤與滑桿皆為拖曳型控制項,拖曳一次會連發數十個事件。不節流會耗盡
 * chrome.storage.sync 的寫入額度,而症狀會出現在完全無關之處
 * (自訂讀音存不進去)。該問題已發生過一次。
 */
let appearanceWriteTimer = null;

function saveAppearanceSoon(key, value) {
  clearTimeout(appearanceWriteTimer);
  appearanceWriteTimer = setTimeout(() => {
    setSetting(key, value).catch((err) => console.warn('[romaji] 寫入外觀設定失敗:', err));
  }, WRITE_DEBOUNCE_MS);
}

function renderColor(value) {
  colorEl.value = value;
  // 選中的色塊須標示出來,否則使用者看不出目前是哪一個
  for (const swatch of document.querySelectorAll('.swatch')) {
    swatch.style.background = swatch.dataset.color;
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === value));
  }
}

function renderScale(value) {
  scaleEl.value = String(value);
  scaleValueEl.textContent = `${value}%`;
}

colorEl.addEventListener('input', () => {
  const value = normalizeColor(colorEl.value);
  renderColor(value);
  saveAppearanceSoon('romajiColor', value);
});

scaleEl.addEventListener('input', () => {
  const value = normalizeScale(scaleEl.value);
  renderScale(value);
  saveAppearanceSoon('romajiScale', value);
});

// 色塊僅是捷徑,調整的是同一個值、走同一條路徑
for (const swatch of document.querySelectorAll('.swatch')) {
  swatch.addEventListener('click', () => {
    const value = normalizeColor(swatch.dataset.color);
    renderColor(value);
    saveAppearanceSoon('romajiColor', value);
  });
}

/*
 * 此處曾有一組「掃描快慢」的控制項,已移除。
 *
 * 理由見 settings.js 的說明:一句唱多久由歌曲本身決定,調快會使字掃到底後
 * 停在句尾等待、調慢會在換行時被截斷,兩個方向皆不正確。掃描的正確行為只有一種。
 * 使用者感受到的「太快」實為整體時間差,由上方的提前量處理 ——
 * 它使整句與逐字一併平移,不致拆散兩者的關係。
 */

/* ------------------------------------------------------------ 自訂讀音 */

function showCorrectionError(message) {
  correctionsErrorEl.textContent = message ?? '';
}

/** 將儲存層回報的失敗原因轉為使用者看得懂的說法 */
function describeFailure(reason) {
  if (reason === 'quota') {
    return '自訂讀音已達瀏覽器同步儲存的上限,請先刪掉幾筆再試。';
  }
  if (reason === 'bad-reading') return '讀音只能填假名。';
  return '存檔失敗,請再試一次。';
}

function buildRow(surface, reading) {
  const li = document.createElement('li');
  li.className = 'correction';

  const surfaceEl = document.createElement('span');
  surfaceEl.className = 'correction-surface';
  surfaceEl.textContent = surface;
  surfaceEl.title = surface; // 過長而被省略時,游標移上仍看得到完整內容

  const arrow = document.createElement('span');
  arrow.className = 'correction-arrow';
  arrow.textContent = '→';

  const input = document.createElement('input');
  input.className = 'correction-reading';
  input.value = reading;
  input.spellcheck = false;
  input.setAttribute('aria-label', `${surface} 的讀音`);

  // 邊輸入邊標示,不待存檔才告知「這個不能用」
  input.addEventListener('input', () => {
    const ok = isValidReading(input.value.trim());
    input.setAttribute('aria-invalid', String(!ok));
    showCorrectionError(null);
  });

  /*
   * 採 change 而非 input:每輸入一個字即寫入一次 storage 會撞上
   * chrome.storage.sync 的寫入頻率上限,撞上之後接下來的寫入會整批失敗。
   * 離開欄位或按下 Enter 時寫入一次即已足夠。
   */
  input.addEventListener('change', async () => {
    const next = input.value.trim();

    // 清空視為「取消這筆修正」,與按下叉叉同義
    if (!next) {
      await removeRow(surface);
      return;
    }
    if (next === reading) return;

    if (!isValidReading(next)) {
      input.setAttribute('aria-invalid', 'true');
      showCorrectionError(describeFailure('bad-reading'));
      return;
    }

    const result = await addUserCorrection(surface, next);
    if (!result.ok) {
      showCorrectionError(describeFailure(result.reason));
      input.value = reading; // 未儲存成功即還原,避免畫面與實際不符
      return;
    }
    showCorrectionError(null);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur(); // blur 會觸發上方的 change
    if (event.key === 'Escape') {
      input.value = reading;
      input.blur();
    }
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'correction-remove';
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', `刪除 ${surface} 的自訂讀音`);
  removeButton.addEventListener('click', () => removeRow(surface));

  li.append(surfaceEl, arrow, input, removeButton);
  return li;
}

async function removeRow(surface) {
  const result = await removeUserCorrection(surface);
  if (!result.ok) {
    showCorrectionError(describeFailure(result.reason));
    return;
  }
  showCorrectionError(null);
  renderCorrections(getUserCorrections());
}

function renderCorrections(entries) {
  // 依原文排序,位置才穩定 —— 物件的鍵序取決於加入的先後,
  // 使用者修改一筆讀音便會使該列跳至別處。
  const list = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'ja'));

  correctionsCountEl.textContent = list.length ? `${list.length} 筆` : '';
  correctionsEl.replaceChildren();

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'corrections-empty';
    empty.textContent = '還沒有自訂讀音';
    correctionsEl.appendChild(empty);
    return;
  }

  for (const [surface, reading] of list) {
    correctionsEl.appendChild(buildRow(surface, reading));
  }
}

/**
 * 頁面上那顆切換鈕變更設定時,開啟中的 popup 須立即跟上。
 * (自行按下 popup 選項時亦會觸發,重繪為同一個值,無害)
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.displayMode) renderModes(normalizeMode(changes.displayMode.newValue));
  if (changes.syncOffsetMs) renderOffset(normalizeOffset(changes.syncOffsetMs.newValue));
  if (changes.romajiColor) renderColor(normalizeColor(changes.romajiColor.newValue));
  if (changes.romajiScale) renderScale(normalizeScale(changes.romajiScale.newValue));
});

/*
 * 自訂讀音在他處被變更(另一個分頁的 Spotify 頁面補了讀音,
 * 或由其他裝置同步而來)即重繪。
 *
 * 但正在編輯時不可重繪 —— 存檔本身即會觸發這個回呼,
 * 重繪會將使用者正在輸入的那個 input 整個替換,游標與尚未儲存的內容一併消失。
 * 以 activeElement 判斷而非設立旗標:焦點是否在列表內是畫面的實際狀態,
 * 旗標則須仰賴每條路徑都記得升降,遲早會有遺漏。
 */
onCorrectionsChanged((entries) => {
  if (correctionsEl.contains(document.activeElement)) return;
  renderCorrections(entries);
});

async function main() {
  const { displayMode, syncOffsetMs, romajiColor, romajiScale } = await getSettings();
  renderModes(displayMode);
  renderOffset(syncOffsetMs);
  renderColor(romajiColor);
  renderScale(romajiScale);

  renderCorrections(await loadUserCorrections());
}

main();
