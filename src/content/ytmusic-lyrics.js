/**
 * ytmusic-lyrics.js
 * YouTube Music(music.youtube.com)的歌詞分頁:將整段歌詞拆成逐句的行元素。
 *
 * ── 與 Spotify 最根本的差別 ──────────────────────────────────
 * Spotify 每一句本就是一個元素,拼音只要插在它下方即可。YouTube Music 的歌詞
 * 則整段放在單一個文字節點裡,以 \n 分行 —— 沒有任何元素可供插入,
 * 必須先自行拆成逐句,才有東西可以處理。
 *
 * 實測結果(2026-09,11 首日文歌、未登入):
 *
 *   1. shelf 為 ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"],
 *      其 div.wrapper 內有兩份本文,class 皆含 description,內容完全相同:
 *
 *        button[hidden] > yt-formatted-string.description     可展開版,YouTube Music 自行隱藏
 *        yt-formatted-string.non-expandable.description       實際顯示的那一份
 *        yt-formatted-string.footer                           「提供元: Musixmatch」等來源標示
 *
 *      兩份本文皆為單一文字節點,childElementCount 為 0。視窗寬度 720px 與換歌後
 *      皆為相同配置,未見兩者對調
 *   2. 換行符號不一定是 \n:LyricFind 的曲目(Lemon、紅蓮華)為 \r\n
 *   3. 未點開「歌詞」分頁之前 shelf 完全不存在於 DOM;點開後即使切回其他分頁,
 *      shelf 仍留在 DOM 中
 *   4. 換歌時 shelf 與本文皆為同一個元素,僅文字節點被替換
 *      (childList,而非 characterData)。在其旁邊插入的元素換歌後仍然存在
 *   5. 未見逐句獨立元素或逐句同步高亮的版本(未登入狀態下無法排除登入後會出現)
 *
 * ── 本模組刻意採取的兩項決定 ──────────────────────────────
 * 一、原生本文只隱藏、不清空。
 *     規劃之初的想法是清空原內容、就地重建。但由第 4 點可知 YouTube Music 換歌時
 *     是去替換本文元素裡的文字節點 —— 若它已被清空或搬走,更新會落空或與拆出來的行
 *     相互干擾。改為在其後方另建一份、原生的僅以 CSS 隱藏,換歌就只是
 *     「原生文字變了 → 重拆一次」,不必與 YouTube Music 爭奪同一個節點。
 *
 * 二、讀取並接在「實際顯示的那一份」之後,且兩份都隱藏。
 *     以 .description 取第一個符合者,拿到的會是 button 內那份已被隱藏的可展開版 ——
 *     首版即是如此:自建的行插在它旁邊,真正顯示的那一份卻原封不動地留在下方,
 *     畫面上變成兩份歌詞(由端對端測試量到 shelf 高度多出一整份才發現)。
 *     接在 non-expandable 之後,來源標示也就仍緊接在歌詞下方。
 *     兩份都標記隱藏的原因:目前顯示的是 non-expandable,但 YouTube Music 哪天改顯示
 *     可展開版的話,只藏一份就會再次出現兩份歌詞。
 *
 * 每一行做成與 LRCLIB 面板同構的元素(見 lrc-panel.js):
 *
 *   <div class="romaji-ytm-line">原文</div>
 *
 * 轉換、顯示模式、手動切分、修正面板全數交由 index.js 的既有流程處理,
 * 此處只負責「文字 → 行元素」這一步。
 */

const SHELF_SELECTOR =
  'ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]';
/** 兩份本文皆符合(見檔頭第 1 點) */
const NATIVE_TEXT_SELECTOR = 'yt-formatted-string.description';
/** 實際顯示的那一份 */
const VISIBLE_TEXT_SELECTOR = 'yt-formatted-string.description.non-expandable';

const CONTAINER_CLASS = 'romaji-ytm-lyrics';
const LINE_CLASS = 'romaji-ytm-line';
/** 標在被隱藏的原生本文上,由 overlay.css 決定何時隱藏(關閉模式下須顯示) */
const NATIVE_ATTR = 'data-romaji-ytm-native';

let containerEl = null;
let hiddenNatives = [];
let lineEls = [];
/** 目前這組行是由哪一段原生文字拆出來的,用以判斷是否換歌 */
let renderedFrom = null;

/* -------------------------------------------------------------- 純函式 */

/**
 * 目前頁面是否為 YouTube Music。
 * hostname 可自外部傳入,供測試使用;平時讀取 location。
 */
export function isYouTubeMusic(hostname = location.hostname) {
  return hostname === 'music.youtube.com';
}

/**
 * 將整段歌詞拆成逐句。
 *
 * 空行不成為一句,而是標記在下一句的 paragraphStart 上。
 * 若將空行也做成行元素,它會走完整條轉換流程成為 'empty',再被純拼音模式
 * 每行都有的上下間距撐成一大塊空白 —— 段落之間的距離應由 CSS 決定,
 * 而非取決於原文剛好有幾個空行。
 *
 * 換行須同時接受 \r\n 與 \r:LyricFind 的曲目為 \r\n,只以 \n 切分的話
 * 每一句尾端會殘留一個 \r。它不可見,卻會進入 romajiSource(手動切分的 key)
 * 與送去轉換的文字,同一句歌詞在 Spotify 上存過的切分便對不上。
 *
 * @param {string} text 原生的整段歌詞
 * @returns {{ text: string, paragraphStart: boolean }[]}
 */
export function splitLyricsText(text) {
  const lines = [];
  let afterBlank = false;

  for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) {
      afterBlank = true;
      continue;
    }
    // 第一句之前的空行沒有「上一段」可分隔,不標記
    lines.push({ text: line, paragraphStart: afterBlank && lines.length > 0 });
    afterBlank = false;
  }

  return lines;
}

/**
 * 由播放列的資訊判定目前曲目。
 *
 * 歌手只認 href 指向 channel/ 的連結。byline 中還有專輯連結(browse/)與年份,
 * 且廣告播放時播放列會顯示廣告名稱、byline 完全沒有連結(實測:標題為
 * 「Uber Eats」)。沒有歌手即回傳 null,廣告便不會被當成一首歌 ——
 * 否則曲目專屬的共用字典會拿廣告名稱去比對。
 *
 * @param {{ title?: string, links?: { text?: string, href?: string|null }[] }} info
 * @returns {{ trackName: string, artistName: string } | null}
 */
export function nowPlayingFrom({ title, links }) {
  const trackName = title?.trim();
  const artist = links?.find((link) => /(^|\/)channel\//.test(link.href ?? ''));
  const artistName = artist?.text?.trim();
  if (!trackName || !artistName) return null;
  return { trackName, artistName };
}

/* ------------------------------------------------------------ DOM 操作 */

/** 讀取播放列上的曲目資訊。與 index.js 的 readNowPlaying 回傳相同形狀 */
export function readYtmNowPlaying() {
  const bar = document.querySelector('ytmusic-player-bar');
  if (!bar) return null;
  return nowPlayingFrom({
    title: bar.querySelector('.title')?.textContent,
    links: [...bar.querySelectorAll('.byline a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
    })),
  });
}

/**
 * 字型與顏色比照原生歌詞。
 *
 * 自建的容器是 div.wrapper 的子元素,而 YouTube Music 的歌詞樣式掛在
 * yt-formatted-string.description 上,繼承不到。直接讀取原生元素的計算結果,
 * 而不在 CSS 中寫死數值:YouTube Music 調整字級時毋須跟著修改。
 * 換歌重建時原生元素已被隱藏,但 display:none 的元素其字型與顏色仍有計算值可讀。
 */
function mirrorTextStyle(from, to) {
  const style = getComputedStyle(from);
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']) {
    to.style[prop] = style[prop];
  }
}

function buildLine({ text, paragraphStart }) {
  const el = document.createElement('div');
  el.className = LINE_CLASS;
  // 刻意只放純文字 —— 包裹 .romaji-original 與插入拼音皆由 index.js 的佇列處理
  el.textContent = text;
  if (paragraphStart) el.dataset.romajiParagraph = 'start';
  return el;
}

function removeContainer() {
  containerEl?.remove();
  for (const el of hiddenNatives) el.removeAttribute(NATIVE_ATTR);
  containerEl = null;
  hiddenNatives = [];
  lineEls = [];
  renderedFrom = null;
}

/**
 * 確保自建的逐句歌詞與原生文字一致,並回傳行元素。
 *
 * 每次掃描都會呼叫,故「無變化」這條路徑須維持低廉:只比對一次文字與位置。
 * 換歌時原生文字改變,即整組重建 —— 舊的行元素隨容器一併移除,
 * 佇列中尚未處理的舊行會因 isConnected 為 false 而被略過。
 *
 * @returns {HTMLElement[]}
 */
export function syncYtmLyrics() {
  const shelf = document.querySelector(SHELF_SELECTOR);
  const natives = shelf ? [...shelf.querySelectorAll(NATIVE_TEXT_SELECTOR)] : [];
  // 兩份內容相同,讀實際顯示的那一份;找不到時才退回任一份(理由見檔頭第二項決定)
  const source = shelf?.querySelector(VISIBLE_TEXT_SELECTOR) ?? natives[0];
  const text = source?.textContent ?? '';

  // 分頁從未開啟過,或歌詞尚在載入
  if (!source || !text.trim()) {
    removeContainer();
    return lineEls;
  }

  /*
   * 緊接在來源之後插入。
   *
   * 退回可展開版時它位於 button 內,須插在 button 之後而非裡面:
   * 按鈕內的文字在 Chrome 中無法以滑鼠選取,而修正面板要靠
   * 「選取一段原文再雙擊」預選範圍;拼音的 tabindex 置於按鈕內亦屬無效的巢狀互動元素。
   */
  const anchor = source.closest('button') ?? source;

  if (containerEl?.isConnected && containerEl.previousElementSibling === anchor && text === renderedFrom) {
    return lineEls;
  }

  removeContainer();

  const container = document.createElement('div');
  container.className = CONTAINER_CLASS;
  mirrorTextStyle(source, container);

  lineEls = splitLyricsText(text).map(buildLine);
  container.append(...lineEls);

  for (const el of natives) el.setAttribute(NATIVE_ATTR, '');
  // 先將行放入容器,再一次插入頁面:只產生一筆 childList 記錄,
  // 且 index.js 的 isOwnRecord 能整筆認出是自己插入的
  anchor.insertAdjacentElement('afterend', container);

  containerEl = container;
  hiddenNatives = natives;
  renderedFrom = text;
  return lineEls;
}

/** 目前的行元素。index.js 的佇列依此決定轉換順序 */
export function getYtmLineElements() {
  return lineEls;
}
