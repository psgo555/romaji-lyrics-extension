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
import { isIterationMarkOnly } from './cjk.js';

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
      <span class="romaji-fix-title"></span>
      <button type="button" class="romaji-fix-close" aria-label="關閉">×</button>
    </div>
    <p class="romaji-fix-hint">點下面的原文選出範圍,要涵蓋<b>整個詞</b>才不會斷錯</p>
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

/**
 * 拖曳選取的起點;null 代表現在沒有在拖。
 * 放在模組層而不是 renderSource 裡面,是因為放開滑鼠的 mouseup 可能發生在
 * 面板外面(手滑出去了),那一下要由 document 收,兩邊得看同一個變數。
 */
let dragAnchor = null;

/**
 * 原文逐字排出來,已選的高亮。
 *
 * 兩種選法:點一下延伸/縮小範圍(適合微調),或是按著拖過去一次選一段
 * (適合「這四個字是一個詞」這種一眼就知道範圍的情況)。
 *
 * 節點只建一次,之後只改 aria-pressed —— 拖曳時每移動一個字就重建整排按鈕的話,
 * 滑鼠底下的元素會被換掉,mouseenter 會再觸發一次,變成自己餵自己。
 */
function renderSource() {
  const container = q('.romaji-fix-source');
  container.replaceChildren();

  state.chars.forEach((char, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'romaji-fix-ch';
    button.textContent = char;

    button.addEventListener('mousedown', (event) => {
      // 不要讓瀏覽器把面板裡的文字選起來,那會蓋掉我們自己的選取提示
      event.preventDefault();
      // 只記起點,**不動選取範圍** —— 真的拖了才算拖曳。
      // 在這裡就把範圍設成這一個字的話,底下「點旁邊的字延伸範圍」會失效:
      // 每一下都先被重設成單一個字,再也延伸不出去。
      dragAnchor = i;
    });

    button.addEventListener('mouseenter', () => {
      if (dragAnchor === null) return;
      setSelection(Math.min(dragAnchor, i), Math.max(dragAnchor, i) + 1);
    });

    /*
     * 點一下:延伸或縮小範圍(原本的行為)。
     *
     * 跨了好幾個字的拖曳不會走到這裡 —— 按下與放開在不同元素上時,
     * click 會派給共同的祖先而不是按鈕本身。原地按放才算點擊,那時
     * 一次 mouseenter 都沒發生過,範圍還是原樣,extendSelection 的判斷才正確。
     */
    button.addEventListener('click', () => {
      extendSelection(i);
      paintSelection();
      schedulePreview();
    });

    container.appendChild(button);
  });

  paintSelection();
}

/** 只更新哪些字是選中的,不動節點 */
function paintSelection() {
  if (!rootEl) return;
  const buttons = rootEl.querySelectorAll('.romaji-fix-ch');
  buttons.forEach((button, i) => {
    button.setAttribute('aria-pressed', String(i >= state.selStart && i < state.selEnd));
  });
}

function setSelection(start, end) {
  if (state.selStart === start && state.selEnd === end) return; // 沒變就不要重畫
  state.selStart = start;
  state.selEnd = end;
  paintSelection();
  schedulePreview();
}

/** 放開滑鼠就結束拖曳,不管放在哪裡 */
function endDrag() {
  dragAnchor = null;
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

/**
 * 目前的選取範圍能不能補讀音。
 *
 * 只選到疊字符(々 之類)是無效的 —— 它讀什麼完全看前面是什麼字,
 * 單獨指定一個讀音必定會弄壞其他所有含它的詞。詳見 cjk.js。
 *
 * @returns {string|null} 不能補時回傳要顯示的原因
 */
function selectionProblem() {
  /*
   * 什麼都沒選中。
   *
   * 從「點紅色底線的字」進來時範圍是預先選好的,不會走到這裡;
   * 但雙擊拼音進來時是空的 —— 那條路必須由使用者自己指出要修哪個詞,
   * 因為拼音反推不回原文的哪一段(轉換不保留對應關係)。
   * 沒有這道防線的話,空字串會被當成一筆讀音存進去。
   */
  if (!selectedSurface()) {
    return '先點下面的原文,選出要修的那個詞';
  }
  if (isIterationMarkOnly(selectedSurface())) {
    return '「々」這種疊字符要跟前面的字一起選 —— 它讀什麼取決於前一個字';
  }
  return null;
}

async function runPreview() {
  if (!rootEl) return;

  /*
   * 選取範圍本身有問題時,立刻講 —— 不要等到使用者填完讀音、
   * 按了儲存才說不行。那時他已經在錯的方向上花了力氣。
   */
  const problem = selectionProblem();
  showError(problem);

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
  // 選取範圍本身無效就不要存,存了會弄壞其他詞
  const problem = selectionProblem();
  if (problem) {
    showError(problem);
    return;
  }

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

  const problem = selectionProblem();
  if (problem) {
    // 分享出去的東西所有人都會拿到,這裡更不能放行
    showError(problem);
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
  document.removeEventListener('mouseup', endDrag, true);
  dragAnchor = null;
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
/**
 * 打開修正面板。
 *
 * @param {object} options
 * @param {string} options.lineText 整句原文,選詞器就是把它逐字攤開
 * @param {string} options.surface 預先選好的範圍;空字串代表「讓使用者自己選」
 * @param {DOMRect} options.anchor 面板要貼在哪個位置下方
 * @param {Function} [options.guardKeydown] index.js 的按鍵防護
 * @param {string} [options.title] 標題。兩種進入點要講的事情不一樣 ——
 *   點紅底線的字是「這個詞讀不出來」,雙擊拼音是「這個詞讀錯了」。
 *   標題若一律寫「補上讀音」,後者會讓使用者以為自己點錯功能。
 */
export function openCorrectionPopover({
  lineText,
  surface,
  anchor,
  guardKeydown,
  title = '補上讀音',
}) {
  closeCorrectionPopover();

  const chars = [...lineText];
  const at = lineText.indexOf(surface);
  const start = at < 0 ? 0 : [...lineText.slice(0, at)].length;

  state = { lineText, chars, selStart: start, selEnd: start + [...surface].length };
  guardKey = guardKeydown;

  rootEl = buildSkeleton();
  rootEl.querySelector('.romaji-fix-title').textContent = title;
  document.body.appendChild(rootEl);

  // 拖到一半滑出面板外面才放開,也要算結束 —— 掛在 document 上才收得到
  document.addEventListener('mouseup', endDrag, true);

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
