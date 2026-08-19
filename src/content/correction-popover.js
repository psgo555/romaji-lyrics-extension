/**
 * correction-popover.js
 * 點一下轉不出來的漢字,當場補上讀音。
 *
 * 為什麼要有這個:kuromoji 的內建辭典一定會有讀不出來的詞,
 * 每遇到一個都要改程式碼、重新 build、重新載入太慢。
 * 這裡讓使用者當場補,存進瀏覽器、立刻生效、之後所有歌曲通用。
 *
 * ── 兩個一定要留意的設計約束 ─────────────────────────────────
 *
 * 1. 必須是**整個詞**,不能只改其中一個字。
 *    只替換一部分會破壞斷詞:把「怨子」的「怨」單獨換成「えん」會變成
 *    「えん子」→ e n ko(多了空格),比原本更糟。
 *    所以有選詞器讓使用者把範圍拉到整個詞,並用即時預覽把結果攤開來看。
 *
 * 2. 不可以干擾既有的「點擊切分」與鍵盤編輯模式。
 *    - 只在**非編輯模式**時才攔截點擊(在轉不出來的漢字裡插空格本來就沒意義)
 *    - 不新增任何 document 層級的按鍵監聽,改成重用 index.js 傳進來的
 *      按鍵防護 —— Spotify 的播放/暫停綁在空白鍵的 keyup,
 *      在輸入框打字時若不擋,打一個空格音樂就停了
 */

import { addUserCorrection, isValidReading } from './corrections-store.js';
import { previewRomaji } from './romaji.js';
import { toKanaReading } from './reading.js';

const PREVIEW_DEBOUNCE_MS = 200;
const PANEL_WIDTH = 320;

let rootEl = null;
let state = null; // { lineText, chars, selStart, selEnd }
let guardKey = null; // index.js 傳進來的按鍵防護
let previewTimer = null;

/* ------------------------------------------------------------ 畫面組裝 */

function buildSkeleton() {
  const root = document.createElement('div');
  root.className = 'romaji-fix';
  root.innerHTML = `
    <div class="romaji-fix-head">
      <span class="romaji-fix-title">補上讀音</span>
      <button type="button" class="romaji-fix-close" aria-label="關閉">×</button>
    </div>
    <p class="romaji-fix-hint">點原文可調整範圍,要涵蓋<b>整個詞</b>才不會斷錯</p>
    <div class="romaji-fix-source" role="group" aria-label="選擇要修正的範圍"></div>
    <input class="romaji-fix-input" type="text"
           placeholder="打羅馬拼音就好,例如 shin no zou"
           aria-label="讀音(可填假名或羅馬拼音)" />
    <p class="romaji-fix-kana" aria-live="polite"></p>
    <p class="romaji-fix-error" role="alert"></p>
    <div class="romaji-fix-preview">
      <span class="romaji-fix-preview-label">預覽</span>
      <span class="romaji-fix-preview-text"></span>
    </div>
    <div class="romaji-fix-actions">
      <button type="button" class="romaji-fix-share" title="把這個讀音提供給其他使用者">
        分享給大家
      </button>
      <button type="button" class="romaji-fix-cancel">取消</button>
      <button type="button" class="romaji-fix-save">儲存</button>
    </div>
  `;
  return root;
}

function q(selector) {
  return rootEl.querySelector(selector);
}

/** 原文逐字排出來,已選的高亮。點相鄰的字可以延伸範圍。 */
function renderSource() {
  const container = q('.romaji-fix-source');
  container.replaceChildren();

  state.chars.forEach((char, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'romaji-fix-ch';
    button.textContent = char;
    button.setAttribute('aria-pressed', String(i >= state.selStart && i < state.selEnd));
    button.addEventListener('click', () => {
      extendSelection(i);
      renderSource();
      schedulePreview();
    });
    container.appendChild(button);
  });
}

/**
 * 點某個字時怎麼調整範圍。
 * 選取必須是連續的一段 —— 中間有洞的話取代出來的結果沒有意義。
 */
function extendSelection(index) {
  const width = state.selEnd - state.selStart;
  if (index < state.selStart) state.selStart = index;
  else if (index >= state.selEnd) state.selEnd = index + 1;
  // 點在選取範圍的邊緣就往內縮,方便調小
  else if (index === state.selStart && width > 1) state.selStart += 1;
  else if (index === state.selEnd - 1 && width > 1) state.selEnd -= 1;
}

function selectedSurface() {
  return state.chars.slice(state.selStart, state.selEnd).join('');
}

/* -------------------------------------------------------------- 預覽 */

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
}

async function runPreview() {
  if (!rootEl) return;

  // 使用者可能打的是羅馬拼音,先轉成假名再判斷
  const reading = toKanaReading(q('.romaji-fix-input').value);
  const surface = selectedSurface();
  const candidate = reading && isValidReading(reading) ? { surface, reading } : null;

  // 把轉出來的假名顯示出來 —— 打羅馬拼音的人要看到它變成什麼,
  // 否則轉錯了也不知道是哪一步出問題
  q('.romaji-fix-kana').textContent = candidate ? reading : '';

  const result = await previewRomaji(state.lineText, candidate);
  if (!rootEl) return; // 等待期間被關掉了

  q('.romaji-fix-preview-text').textContent = result ?? '(轉不出來)';
}

function showError(message) {
  q('.romaji-fix-error').textContent = message ?? '';
}

/* -------------------------------------------------------------- 存檔 */

async function save() {
  // 跟預覽走同一條路:先轉假名再驗證。兩邊若不一致,
  // 會出現「預覽看起來對、按儲存卻說格式錯」這種莫名其妙的狀況。
  const reading = toKanaReading(q('.romaji-fix-input').value);

  if (!isValidReading(reading)) {
    showError('讀音請填假名或羅馬拼音,例如 しんのぞう 或 shin no zou');
    return;
  }

  const result = await addUserCorrection(selectedSurface(), reading);
  if (result.ok) {
    closeCorrectionPopover();
    return;
  }

  /*
   * 'write-failed' 最常見的原因是**寫入頻率**上限,不是空間不足 ——
   * chrome.storage.sync 每分鐘只能寫約 120 次,超過之後所有寫入都會失敗。
   * 只說「請再試一次」會讓使用者立刻再按一次、再失敗一次,更困惑。
   * 講清楚要等一下,他才知道該怎麼做。
   */
  showError(
    result.reason === 'quota'
      ? '自訂讀音已達瀏覽器同步空間上限,請先刪掉一些'
      : '儲存失敗 —— 剛才可能存太頻繁了,等十幾秒再按一次儲存'
  );
}

/* ------------------------------------------------------ 分享給其他人 */

/*
 * 專案的 issue 頁面。由 build.mjs 從 package.json 注入 —— 跟 LRCLIB 的
 * 來源識別同一個道理,不在程式裡寫死第二份網址。
 */
const REPO_URL =
  typeof __REPO_URL__ === 'string' ? __REPO_URL__ : '';

/**
 * 把這一筆讀音開成一個預先填好的 GitHub issue。
 *
 * ── 為什麼是開 issue,不是直接上傳 ────────────────────────────
 * 共用字典是所有使用者都會拿到的。如果誰都能直接寫進去,
 * 一筆錯的讀音就會讓所有人的畫面**很有自信地顯示錯的拼音** ——
 * 那比轉不出來更糟,因為沒有人看得出來它是錯的。
 *
 * 開 issue 保留了「有人看過再合併」這一步,而預先填好內容讓使用者
 * 不需要懂 GitHub —— 他只要按送出。
 *
 * 完全不會自動送出任何東西:按下去只是開一個新分頁,
 * 內容長什麼樣他自己看得到,不想送就關掉。
 */
function shareCorrection() {
  if (!REPO_URL) {
    showError('這個版本沒有設定專案網址,無法分享');
    return;
  }

  const surface = selectedSurface();
  const reading = toKanaReading(q('.romaji-fix-input').value);

  if (!isValidReading(reading)) {
    showError('先把讀音填好再分享(只能填假名或羅馬拼音)');
    return;
  }

  const body = [
    '<!-- 這是自動填好的,確認沒問題就直接送出 -->',
    '',
    `- 原文:\`${surface}\``,
    `- 讀音:\`${reading}\``,
    `- 這一句:${state.lineText}`,
    '',
    '（如果知道是哪首歌,補在這裡會更好查證）',
    '曲名 / 歌手:',
  ].join('\n');

  const url =
    `${REPO_URL}/issues/new` +
    `?title=${encodeURIComponent(`補讀音:${surface} → ${reading}`)}` +
    `&body=${encodeURIComponent(body)}`;

  window.open(url, '_blank', 'noopener');
}

/* ------------------------------------------------------------ 對外介面 */

export function isPopoverOpen() {
  return Boolean(rootEl);
}

export function closeCorrectionPopover() {
  if (!rootEl) return;
  clearTimeout(previewTimer);
  rootEl.remove();
  rootEl = null;
  state = null;
}

/**
 * @param {object} options
 * @param {string} options.lineText 整行原文
 * @param {string} options.surface  偵測到轉不出來的那一段(預選範圍)
 * @param {DOMRect} options.anchor  點擊處,用來決定面板出現在哪
 * @param {(event: KeyboardEvent) => void} options.guardKeydown
 *        重用 index.js 的按鍵防護,避免在輸入框打空格時觸發 Spotify 播放/暫停
 */
export function openCorrectionPopover({ lineText, surface, anchor, guardKeydown }) {
  closeCorrectionPopover();

  const chars = [...lineText];
  const at = lineText.indexOf(surface);
  const start = at < 0 ? 0 : [...lineText.slice(0, at)].length;

  state = { lineText, chars, selStart: start, selEnd: start + [...surface].length };
  guardKey = guardKeydown;

  rootEl = buildSkeleton();
  document.body.appendChild(rootEl);

  // 放在點擊處下方,超出畫面就往回收
  const left = Math.min(
    Math.max(8, anchor.left - PANEL_WIDTH / 2),
    window.innerWidth - PANEL_WIDTH - 8
  );
  rootEl.style.left = `${left}px`;
  rootEl.style.top = `${Math.min(anchor.bottom + 8, window.innerHeight - 280)}px`;

  renderSource();

  const input = q('.romaji-fix-input');
  input.addEventListener('input', () => {
    showError('');
    schedulePreview();
  });

  // 在捕獲階段擋下按鍵,不讓 Spotify 收到 —— 尤其是空白鍵(它的播放/暫停
  // 綁在 keyup),否則使用者打一個空格音樂就停了
  rootEl.addEventListener(
    'keydown',
    (event) => {
      guardKey?.(event);
      event.stopPropagation();
      if (event.key === 'Escape') closeCorrectionPopover();
      if (event.key === 'Enter') save();
    },
    true
  );

  q('.romaji-fix-close').addEventListener('click', closeCorrectionPopover);
  q('.romaji-fix-cancel').addEventListener('click', closeCorrectionPopover);
  q('.romaji-fix-save').addEventListener('click', save);
  q('.romaji-fix-share').addEventListener('click', shareCorrection);

  input.focus();
  runPreview();
}

/** 點在面板外面就關掉。由 index.js 在既有的委派裡呼叫,不另外掛 listener。 */
export function handleOutsideClick(target) {
  if (!rootEl || rootEl.contains(target)) return false;
  closeCorrectionPopover();
  return true;
}
