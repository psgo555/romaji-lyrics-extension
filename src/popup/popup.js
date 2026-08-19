/**
 * popup.js
 * 設定介面:顯示方式、高亮提前量、掃描速度,以及自訂讀音的管理。
 * 寫入 chrome.storage.sync 之後,content script 透過 storage.onChanged 立即套用。
 */

import {
  getSettings,
  setSetting,
  normalizeMode,
  normalizeOffset,
  normalizeSweepSpeed,
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
const sweepEl = document.getElementById('sweep');
const sweepValueEl = document.getElementById('sweep-value');
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

    const hint = document.createElement('span');
    hint.className = 'mode-hint';
    hint.textContent = mode.hint;

    button.append(label, hint);
    button.addEventListener('click', async () => {
      renderModes(mode.value); // 先更新畫面,不等 storage 寫完
      await setSetting('displayMode', mode.value);
    });

    modesEl.appendChild(button);
  }
}

/** 提前量:正值代表提早亮,顯示成「+900 ms」比較好懂 */
function renderOffset(value) {
  offsetEl.value = String(value);
  offsetValueEl.textContent = `${value > 0 ? '+' : ''}${value} ms`;
}

/** 掃描快慢是倍率,顯示成「100%」比毫秒好懂 */
function renderSweep(value) {
  sweepEl.value = String(value);
  sweepValueEl.textContent = `${value}%`;
}

/*
 * 拖曳過程中就寫入(input 事件),不等放開(change 事件)——
 * 這樣使用者可以一邊播一邊拖,即時看到對不對得上。
 * content script 那邊是靠 storage.onChanged 立即套用的。
 */
offsetEl.addEventListener('input', () => {
  const value = normalizeOffset(offsetEl.value);
  renderOffset(value);
  setSetting('syncOffsetMs', value).catch((err) =>
    console.warn('[romaji] 寫入提前量失敗:', err)
  );
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
  setSetting('syncOffsetMs', value).catch((err) =>
    console.warn('[romaji] 寫入提前量失敗:', err)
  );
}

for (const id of ['offset-later', 'offset-earlier']) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => nudgeOffset(Number(button.dataset.delta)));
}

sweepEl.addEventListener('input', () => {
  const value = normalizeSweepSpeed(sweepEl.value);
  renderSweep(value);
  setSetting('sweepSpeed', value).catch((err) =>
    console.warn('[romaji] 寫入掃描快慢失敗:', err)
  );
});

/* 以 10% 為單位的加減,跟提前量那組同一個道理:滑桿難對準,按鈕才好用 */
function nudgeSweep(delta) {
  const value = normalizeSweepSpeed(Number(sweepEl.value) + delta);
  renderSweep(value);
  setSetting('sweepSpeed', value).catch((err) =>
    console.warn('[romaji] 寫入掃描快慢失敗:', err)
  );
}

for (const id of ['sweep-slower', 'sweep-faster']) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => nudgeSweep(Number(button.dataset.delta)));
}

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
  if (changes.sweepSpeed) renderSweep(normalizeSweepSpeed(changes.sweepSpeed.newValue));
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
  const { displayMode, syncOffsetMs, sweepSpeed } = await getSettings();
  renderModes(displayMode);
  renderOffset(syncOffsetMs);
  renderSweep(sweepSpeed);

  renderCorrections(await loadUserCorrections());
}

main();
