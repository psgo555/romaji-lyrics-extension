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
  DISPLAY_MODES,
} from '../shared/settings.js';

/*
 * 這一支在 src/content/ 底下,但它其實不綁 content script ——
 * 它只碰 chrome.storage 與純邏輯,popup 一樣跑得動。
 *
 * 為什麼寧可跨目錄匯入也不在 popup 自己寫一份:那裡面有儲存格式版本、
 * 內建表與使用者表的合併規則、以及 sync 的容量上限檢查。
 * 複製一份出來,兩邊遲早會對這些規則有不同的理解 —— 而那種不一致
 * 不會噴錯,只會讓使用者的資料安靜地壞掉。(長音符那次就是這樣。)
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
      renderModes(mode.value); // 先更新畫面,不等 storage 寫完
      await setSetting('displayMode', mode.value);
    });

    modesEl.appendChild(button);
  }
}

/*
 * 滑桿的範圍與刻度從 settings.js 帶進來,HTML 裡不寫死。
 *
 * 那三個數字跟 normalizeOffset 夾範圍用的是同一組;寫兩份的話,改了 HTML
 * 卻忘了改 settings.js 就會變成「滑桿拉得到 3000,存進去被砍回 2000」——
 * 畫面顯示跟實際生效不一致,而且不會有任何錯誤訊息。
 */
offsetEl.min = String(SYNC_OFFSET_MIN);
offsetEl.max = String(SYNC_OFFSET_MAX);
offsetEl.step = String(SYNC_OFFSET_STEP);

/** 存的是毫秒,顯示成「提早 0.9 秒」—— 沒人在讀毫秒的 */
function renderOffset(value) {
  offsetEl.value = String(value);
  offsetValueEl.textContent = describeOffset(value);
}

/*
 * 拖曳過程中就寫入(input 事件),不等放開(change 事件)——
 * 這樣使用者可以一邊播一邊拖,即時看到對不對得上。
 * content script 那邊是靠 storage.onChanged 立即套用的。
 */
/*
 * 拖曳過程中寫入要節流。
 *
 * chrome.storage.sync 有每分鐘約 120 次的寫入上限,超過之後**接下來所有
 * 寫入都會失敗** —— 包括別的功能。而滑桿拖一次會連發幾十個 input 事件,
 * 幾秒鐘就能把額度用光,然後使用者去存自訂讀音就會莫名其妙失敗。
 * (實際發生過:拖滑桿調整之後,補讀音按儲存沒反應。)
 *
 * 這個陷阱在自訂讀音的輸入框已經避開了(那裡用 change 不用 input),
 * 但滑桿當初漏掉,踩了同一個坑。
 *
 * 畫面**立刻**更新、只有寫入延後 —— 拖的時候還是即時看得到數字,
 * 停手 250ms 才真的寫進去。content script 是靠 storage.onChanged 套用的,
 * 所以實際效果會慢那一下下,對「一邊播一邊對準」完全不影響。
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
 * 為什麼在滑桿之外還要這個:滑桿一格是 50ms,要移動 0.5 秒得拉十格,
 * 而使用者實際感覺到的是「早了大概半秒」這種粒度 —— 用滑桿去湊很難對準。
 * 滑桿保留下來,是因為粗調對準之後往往還想微調一點點。
 *
 * 關鍵是**兩者調的是同一個值**:按鈕不自己記狀態,而是讀目前的值加減之後,
 * 走跟滑桿完全相同的那條路(normalizeOffset → 畫面 → 儲存)。
 * 各記一份的話兩邊遲早會對不上 —— 這個專案已經在別處踩過這種坑。
 *
 * 夾範圍的事完全交給 normalizeOffset,這裡不重複判斷上下限。
 */
function nudgeOffset(deltaMs) {
  const value = normalizeOffset(Number(offsetEl.value) + deltaMs);
  renderOffset(value);
  // 按鈕也走節流那條:使用者可能連按好幾下對準,那一樣是連續寫入
  saveOffsetSoon(value);
}

for (const id of ['offset-later', 'offset-earlier']) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => nudgeOffset(Number(button.dataset.delta)));
}

/*
 * 這裡曾經有一組「掃描快慢」的控制項,拿掉了。
 *
 * 理由見 settings.js 的說明:一句唱多久是歌本身決定的,調快會讓字掃到底後
 * 停在句尾乾等、調慢會在換行時被截斷,兩邊都不對。掃描的正確行為只有一種。
 * 使用者感覺到的「太快」其實是整體時間差,那由上面的提前量處理 ——
 * 它讓整句與逐字一起平移,不會拆散兩者的關係。
 */

/* ------------------------------------------------------------ 自訂讀音 */

function showCorrectionError(message) {
  correctionsErrorEl.textContent = message ?? '';
}

/** 儲存層回報的失敗原因翻成使用者看得懂的話 */
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
  surfaceEl.title = surface; // 太長被省略時,滑上去仍看得到完整內容

  const arrow = document.createElement('span');
  arrow.className = 'correction-arrow';
  arrow.textContent = '→';

  const input = document.createElement('input');
  input.className = 'correction-reading';
  input.value = reading;
  input.spellcheck = false;
  input.setAttribute('aria-label', `${surface} 的讀音`);

  // 邊打邊標,不要等到存檔才說「這個不能用」
  input.addEventListener('input', () => {
    const ok = isValidReading(input.value.trim());
    input.setAttribute('aria-invalid', String(!ok));
    showCorrectionError(null);
  });

  /*
   * change 而不是 input:每敲一個字就寫一次 storage 會撞到
   * chrome.storage.sync 的寫入頻率上限,撞到之後接下來的寫入會整批失敗。
   * 離開欄位或按 Enter 時存一次就夠。
   */
  input.addEventListener('change', async () => {
    const next = input.value.trim();

    // 清空當作「取消這筆修正」,跟按叉叉同義
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
      input.value = reading; // 沒存成功就還原,免得畫面說謊
      return;
    }
    showCorrectionError(null);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur(); // blur 會觸發上面的 change
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
  // 照原文排序,位置才穩定 —— 物件的鍵序是「誰先被加進來」,
  // 使用者改一筆讀音就會讓那一列跳到別的地方去。
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
 * 頁面上那顆切換鈕改了設定時,開著的 popup 要立刻跟上。
 * (自己按 popup 選項時也會觸發,重畫成同一個值,無害)
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.displayMode) renderModes(normalizeMode(changes.displayMode.newValue));
  if (changes.syncOffsetMs) renderOffset(normalizeOffset(changes.syncOffsetMs.newValue));
});

/*
 * 自訂讀音在別處被改了(另一個分頁的 Spotify 頁面補了一個讀音、
 * 或其他裝置同步過來)就重畫。
 *
 * 但**正在編輯時不能重畫** —— 存檔本身就會觸發這個回呼,
 * 重畫會把使用者正在打字的那個 input 整個換掉,游標與還沒存的內容一起消失。
 * 用 activeElement 判斷而不是設旗標:焦點在不在列表裡是畫面的實際狀態,
 * 旗標則要靠每個路徑都記得升降,遲早會漏。
 */
onCorrectionsChanged((entries) => {
  if (correctionsEl.contains(document.activeElement)) return;
  renderCorrections(entries);
});

async function main() {
  const { displayMode, syncOffsetMs } = await getSettings();
  renderModes(displayMode);
  renderOffset(syncOffsetMs);

  renderCorrections(await loadUserCorrections());
}

main();
