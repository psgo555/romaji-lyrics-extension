/**
 * correction-popover.js
 * 點選轉換失敗的漢字,當場補上讀音。
 *
 * 必要性:kuromoji 的內建辭典必然存在讀不出來的詞,若每遇一個便修改程式碼、
 * 重新 build 並重新載入,速度過慢。此處讓使用者當場補上,存入瀏覽器後立即生效,
 * 之後所有歌曲皆通用。
 *
 * ── 兩項須留意的設計約束 ─────────────────────────────────────
 *
 * 1. 必須以整個詞為單位,不可只修改其中一個字。
 *    僅替換一部分會破壞斷詞:將「怨子」的「怨」單獨換成「えん」會得到
 *    「えん子」→ e n ko(多出空格),較原本更差。
 *    故提供選詞器讓使用者將範圍拉至整個詞,並以即時預覽呈現結果。
 *
 * 2. 不可干擾既有的「點擊切分」與鍵盤編輯模式。
 *    - 僅在非編輯模式時攔截點擊(在轉換失敗的漢字中插入空格本無意義)
 *    - 不新增任何 document 層級的按鍵監聽,改為重用 index.js 傳入的按鍵防護 ——
 *      Spotify 的播放/暫停綁在空白鍵的 keyup,於輸入框打字時若不攔截,
 *      輸入一個空格便會停止播放
 */

import { addUserCorrection, isValidReading } from './corrections-store.js';
import { previewRomaji } from './romaji.js';
import { toKanaReading } from './reading.js';
import { isIterationMarkOnly } from './cjk.js';
import { nextSelection } from './selection-range.js';

const PREVIEW_DEBOUNCE_MS = 200;
const PANEL_WIDTH = 320;

let rootEl = null;
let state = null; // { lineText, chars, selStart, selEnd }
let guardKey = null; // index.js 傳入的按鍵防護
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
    <p class="romaji-fix-hint">點一下＝選到這個字為止,拖曳＝選一段。要涵蓋<b>整個詞</b></p>
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
 * 拖曳選取的起點;null 代表目前未在拖曳。
 * 置於模組層而非 renderSource 內部,是因為放開滑鼠的 mouseup 可能發生於面板之外
 * (游標滑出),該事件須由 document 接收,兩處必須看到同一個變數。
 */
let dragAnchor = null;

/**
 * 將原文逐字排出,已選取者高亮。
 *
 * 提供兩種選法:點擊以延伸或縮小範圍(適合微調),或按住拖曳一次選取一段
 * (適合「這四個字是一個詞」這類範圍一目了然的情況)。
 *
 * 節點僅建立一次,之後只更新 aria-pressed —— 若拖曳時每移動一個字便重建整排按鈕,
 * 游標下方的元素會被替換,mouseenter 將再次觸發,形成自我循環。
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
      // 避免瀏覽器將面板內的文字選取起來,那會蓋掉自訂的選取提示
      event.preventDefault();
      // 僅記錄起點,不變更選取範圍 —— 實際拖曳才視為拖曳。
      // 若在此即將範圍設為單一字,下方「點擊鄰近字以延伸範圍」將失效:
      // 每一次按下都會先被重設為單一字,再也延伸不出去。
      dragAnchor = i;
    });

    button.addEventListener('mouseenter', () => {
      if (dragAnchor === null) return;
      setSelection(Math.min(dragAnchor, i), Math.max(dragAnchor, i) + 1);
    });

    /*
     * 點擊:延伸或縮小範圍(既有行為)。
     *
     * 跨越數字的拖曳不會進入此處 —— 按下與放開位於不同元素時,
     * click 會派送至共同祖先而非按鈕本身。原地按放才算點擊,
     * 此時未曾發生 mouseenter,範圍維持原樣,extendSelection 的判斷方為正確。
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

/** 僅更新哪些字為選取狀態,不變動節點 */
function paintSelection() {
  if (!rootEl) return;
  const buttons = rootEl.querySelectorAll('.romaji-fix-ch');
  buttons.forEach((button, i) => {
    button.setAttribute('aria-pressed', String(i >= state.selStart && i < state.selEnd));
  });
}

function setSelection(start, end) {
  if (state.selStart === start && state.selEnd === end) return; // 未變更則不重繪
  state.selStart = start;
  state.selEnd = end;
  paintSelection();
  schedulePreview();
}

/** 放開滑鼠即結束拖曳,不論放開的位置為何 */
function endDrag() {
  dragAnchor = null;
}

function extendSelection(index) {
  const next = nextSelection({ start: state.selStart, end: state.selEnd }, index);
  state.selStart = next.start;
  state.selEnd = next.end;
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
 * 目前的選取範圍是否可補讀音。
 *
 * 僅選到疊字符(々 之類)為無效 —— 其讀音完全取決於前一個字,
 * 單獨指定讀音必然破壞其他所有含該符號的詞。詳見 cjk.js。
 *
 * @returns {string|null} 不可補時回傳應顯示的原因
 */
function selectionProblem() {
  /*
   * 未選取任何內容。
   *
   * 由「點選紅色底線的字」進入時範圍已預先選好,不會走到此處;
   * 但雙擊拼音進入時範圍為空 —— 該路徑必須由使用者自行指出要修改的詞,
   * 因為拼音無法反推回原文的對應區段(轉換不保留對應關係)。
   * 缺少此道防線時,空字串會被當作一筆讀音存入。
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
   * 選取範圍本身有問題時立即提示,不待使用者填完讀音、按下儲存才告知 ——
   * 屆時他已在錯誤的方向上耗費心力。
   */
  const problem = selectionProblem();
  showError(problem);

  // 輸入可能為羅馬拼音,先轉為假名再行判斷
  const reading = toKanaReading(q('.romaji-fix-input').value);
  const surface = selectedSurface();

  /*
   * 範圍有問題時不組出候選條目。
   *
   * 尤以空的 surface 為甚:那會使取代迴圈永不前進,分頁當場 Out of Memory
   * (雙擊開啟面板時範圍預設為空,使用者一邊輸入一邊預覽即會觸發)。
   * corrections.js 亦有防範,但那是最後一道防線 ——
   * 明知該筆不可用仍傳入,本無道理。
   */
  const candidate = !problem && reading && isValidReading(reading) ? { surface, reading } : null;

  // 顯示轉換後的假名 —— 輸入羅馬拼音者須看見其結果,
  // 否則轉換有誤時無從得知是哪一步出問題
  q('.romaji-fix-kana').textContent = candidate ? reading : '';

  const result = await previewRomaji(state.lineText, candidate);
  if (!rootEl) return; // 等待期間面板已關閉

  q('.romaji-fix-preview-text').textContent = result ?? '(轉不出來)';
}

function showError(message) {
  q('.romaji-fix-error').textContent = message ?? '';
}

/* -------------------------------------------------------------- 存檔 */

async function save() {
  // 選取範圍無效則不儲存,存入會破壞其他詞
  const problem = selectionProblem();
  if (problem) {
    showError(problem);
    return;
  }

  // 與預覽採同一路徑:先轉假名再驗證。兩處若不一致,
  // 將出現「預覽看起來正確、按下儲存卻提示格式錯誤」的矛盾情形。
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
   * 'write-failed' 最常見的成因是寫入頻率上限,而非空間不足 ——
   * chrome.storage.sync 每分鐘僅能寫入約 120 次,超過之後所有寫入皆會失敗。
   * 僅提示「請再試一次」會使使用者立即重按並再次失敗,更為困惑;
   * 明確說明須稍候,他才知道該如何處置。
   */
  showError(
    result.reason === 'quota'
      ? '自訂讀音已達瀏覽器同步空間上限,請先刪掉一些'
      : '儲存失敗 —— 剛才可能存太頻繁了,等十幾秒再按一次儲存'
  );
}

/* ------------------------------------------------------ 分享給其他人 */

/*
 * 專案的 issue 頁面。由 build.mjs 自 package.json 注入 ——
 * 與 LRCLIB 的來源識別同理,不在程式中寫入第二份網址。
 */
const REPO_URL =
  typeof __REPO_URL__ === 'string' ? __REPO_URL__ : '';

/**
 * 將該筆讀音開成一個預先填好的 GitHub issue。
 *
 * ── 採開 issue 而非直接上傳的理由 ────────────────────────────
 * 共用字典是所有使用者都會取得的。若任何人皆可直接寫入,
 * 一筆錯誤的讀音便會使所有人的畫面以確信的樣態顯示錯誤的拼音 ——
 * 那較轉換失敗更糟,因為無人看得出它是錯的。
 *
 * 開 issue 保留了「經人審閱再合併」這一步,而預先填好內容使使用者
 * 毋須熟悉 GitHub —— 僅需按下送出。
 *
 * 不會自動送出任何內容:按下後僅開啟一個新分頁,
 * 內容可自行檢視,不願送出即可關閉。
 */
function shareCorrection() {
  if (!REPO_URL) {
    showError('這個版本沒有設定專案網址,無法分享');
    return;
  }

  const problem = selectionProblem();
  if (problem) {
    // 分享出去的內容所有人都會取得,此處更不可放行
    showError(problem);
    return;
  }

  const surface = selectedSurface();
  const reading = toKanaReading(q('.romaji-fix-input').value);

  if (!isValidReading(reading)) {
    showError('先把讀音填好再分享(只能填假名或羅馬拼音)');
    return;
  }

  /*
   * 曲名自動帶入,且回報預設即為限定這首歌。
   *
   * ── 不讓回報者選擇是否全域生效的理由 ──────────────────────
   * 該判斷超出其能力範圍。「失 → な」在他這首歌是正確的,全域生效卻會使
   * 失敗變成なはい —— 要作此判斷須先想過該字在其他詞中的讀法,
   * 等於此功能僅有懂日文者能使用。
   *
   * 因此回報者只需陳述「這首歌的這個詞唸這樣」,那是他看得到的事實;
   * 是否提升為通用條目由處理 issue 者決定,那才是需要判斷的部分。
   */
  const body = [
    '<!-- 這是自動填好的,確認沒問題就直接送出 -->',
    '',
    `- 曲名:${state.songTitle || '(請補上)'}`,
    `- 原文:\`${surface}\``,
    `- 讀音:\`${reading}\``,
    `- 這一句:${state.lineText}`,
    '',
    '這筆修正**只會套用在上面那首歌**,不影響其他歌。',
    '如果這個詞不管哪首歌都該這樣讀,請在下面說一聲,會改成通用條目。',
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
 * 開啟修正面板。
 *
 * @param {object} options
 * @param {string} options.lineText 整句原文,選詞器即是將其逐字攤開
 * @param {string} options.surface 預先選定的範圍;空字串代表由使用者自行選取
 * @param {DOMRect} options.anchor 點擊處,面板將出現於其下方
 * @param {Function} [options.guardKeydown] index.js 的按鍵防護,
 *   避免在輸入框打空格時觸發 Spotify 的播放/暫停
 * @param {string} [options.title] 標題。兩種進入點所要陳述的事情不同 ——
 *   點選紅色底線的字是「這個詞讀不出來」,雙擊拼音是「這個詞讀錯了」。
 *   標題若一律寫「補上讀音」,後者會使使用者誤以為點錯功能。
 * @param {string} [options.songTitle] 曲名,分享時帶入 issue
 */
export function openCorrectionPopover({
  lineText,
  surface,
  anchor,
  guardKeydown,
  title = '補上讀音',
  songTitle = '',
}) {
  closeCorrectionPopover();

  const chars = [...lineText];
  const at = lineText.indexOf(surface);
  const start = at < 0 ? 0 : [...lineText.slice(0, at)].length;

  state = { lineText, chars, selStart: start, selEnd: start + [...surface].length, songTitle };
  guardKey = guardKeydown;

  rootEl = buildSkeleton();
  rootEl.querySelector('.romaji-fix-title').textContent = title;
  document.body.appendChild(rootEl);

  // 拖曳中游標滑出面板後才放開亦須視為結束 —— 掛於 document 才接收得到
  document.addEventListener('mouseup', endDrag, true);

  // 置於點擊處下方,超出畫面則往內收
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

  // 於捕獲階段攔下按鍵,不使 Spotify 收到 —— 尤以空白鍵為要
  // (其播放/暫停綁在 keyup),否則輸入一個空格便會停止播放
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

/** 點擊面板之外即關閉。由 index.js 於既有的事件委派中呼叫,不另掛 listener。 */
export function handleOutsideClick(target) {
  if (!rootEl || rootEl.contains(target)) return false;
  closeCorrectionPopover();
  return true;
}
