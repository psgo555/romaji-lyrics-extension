/**
 * cjk.js
 * 日文字元的判定規則,集中在這裡一份。
 *
 * 為什麼要獨立成一支:
 * 1. romaji.js 的「這行需不需要轉換」與「哪幾個字沒轉出來」問的是同一件事,
 *    規則分散在兩處遲早會走鐘。
 * 2. 原本的寫法是把邊界字元直接打在正規表達式裡,那要靠每個編輯器、
 *    每個工具鏈都正確地來回轉 UTF-8 才不會壞掉。改用 \uXXXX 逃脫字元,
 *    順便自我說明是哪一段 Unicode 區塊。
 *
 * 涵蓋範圍比舊版多了幾段,都是實際會遇到的:
 * - U+3005 々(人々、時々)、U+3006 〆、U+303B 〻
 * - U+F900–FAFF 相容漢字 —— kuroshiro 自己的 isKanji 有含這段,
 *   我們的判斷卻沒有,等於「引擎轉得出來但我們不讓它轉」
 * - U+FF66–FF9F 半形片假名
 * - U+20000 以上的擴充漢字(要用 u flag)
 */

/**
 * 判定為「日文,需要轉換」的字元集合。
 * 注意這裡不含標點 —— 標點見下面的 JP_PUNCT。
 */
export const JP_CHAR =
  '\\u3005\\u3006\\u303b' + // 々〆〻
  '\\u3040-\\u30ff' + // 平假名 + 片假名(含長音符 U+30FC)
  '\\u31f0-\\u31ff' + // 片假名語音擴充
  '\\u3400-\\u4dbf' + // CJK 擴充 A
  '\\u4e00-\\u9fff' + // CJK 基本區
  '\\uf900-\\ufaff' + // CJK 相容漢字
  '\\uff66-\\uff9f' + // 半形片假名
  '\\u{20000}-\\u{2ebef}' + // CJK 擴充 B/C/D/E/F
  '\\u{2f800}-\\u{2fa1f}'; // CJK 相容補充

/**
 * 只有漢字的子集合(不含假名)。
 *
 * 平假名注音模式要用:那個模式的輸出整片都是假名,拿 JP_CHAR 去掃
 * 會把每一個字都當成「沒轉出來」而整行標紅。那個模式下真正沒轉出來的
 * 是**原樣留著的漢字**,所以判斷條件必須換一組。
 */
export const KANJI_CHAR =
  '\\u3005\\u3006\\u303b' + // 々〆〻(疊字符,讀音跟著前一個字走)
  '\\u3400-\\u4dbf' + // CJK 擴充 A
  '\\u4e00-\\u9fff' + // CJK 基本區
  '\\uf900-\\ufaff' + // CJK 相容漢字
  '\\u{20000}-\\u{2ebef}' + // CJK 擴充 B/C/D/E/F
  '\\u{2f800}-\\u{2fa1f}'; // CJK 相容補充

/** 單一字元的判定,給 hasJapanese 用 */
const JP_RE = new RegExp(`[${JP_CHAR}]`, 'u');

/** 全域版,給掃描用(有 lastIndex 狀態,不要外流) */
const JP_RE_GLOBAL = new RegExp(`[${JP_CHAR}]`, 'gu');
const KANJI_RE_GLOBAL = new RegExp(`[${KANJI_CHAR}]`, 'gu');

/**
 * 會合法地留在羅馬拼音輸出裡的日文標點。
 * kuroshiro 不會把這些轉成英文標點,所以它們留在結果裡是正常的,
 * 「哪些字沒轉出來」的偵測必須排除它們,否則會整片誤標。
 *
 * 刻意不放進 JP_CHAR:整行只有標點的話不該被當成需要轉換的日文。
 */
export const JP_PUNCT = /[　-〄〇-〺〼-〿・｡-･]/u;

/**
 * 疊字符 —— 意思是「重複前一個字」,本身沒有固定讀音。
 *
 *   々  漢字用(時々、人々)
 *   〻  漢字用的直式變體
 *   ゝゞ 平假名用
 *   ヽヾ 片假名用
 *   〃  同上符號
 */
const ITERATION_MARKS = /^[々〻ゝゞヽヾ〃]+$/u;

/**
 * 這段文字是不是**只有**疊字符?
 *
 * ── 為什麼需要這個判斷 ────────────────────────────────────────
 * 疊字符讀什麼**完全取決於前面是什麼字**:
 *
 *   時々 → ときどき   々 讀 どき
 *   人々 → ひとびと   々 讀 びと
 *   様々 → さまざま   々 讀 ざま
 *   日々 → ひび       々 讀 び
 *
 * 所以「單獨替 々 指定一個讀音」在定義上就是錯的 —— 不管填哪一個,
 * 其他所有含 々 的詞都會被弄壞。
 *
 * 這在補讀音的面板上是很自然會踩到的坑:轉不出來的就是那個 々,
 * 使用者直覺就想替它補讀音。實際發生過(時時々,有人想填 々=どき),
 * 而那一筆若進了共用字典,人々 就會變成 ひとどき —— 影響所有使用者。
 *
 * 正確做法是把範圍拉到整個詞再補。
 */
export function isIterationMarkOnly(text) {
  return ITERATION_MARKS.test(text ?? '');
}

/** 單一疊字符的比對,給下面的清除用 */
const ITERATION_MARK_GLOBAL = /[々〻ゝゞヽヾ〃]/gu;

/**
 * 拿掉活到最後、原樣掉進羅馬拼音裡的疊字符。
 *
 * ── 為什麼「活下來」就代表它是壞的 ────────────────────────────
 * 疊字符的意思是「重複前一個字」,所以它**永遠是某個詞的一部分**。
 * 轉換正常時它會跟前面的字一起被處理掉,根本不會出現在結果裡:
 *
 *   時々 → tokidoki      人々 → hitobito
 *   様々 → samazama      日々 → hibi        (實測,都不需要任何字典條目)
 *
 * 反過來說,它若原樣留在輸出裡,就代表**它沒有配對到任何東西** ——
 * 多半是歌詞來源打錯(例如「時時々」多打一個時,留下孤立的 々)。
 *
 * 那時候拿掉它才是對的:前面的字已經正確轉出來了,那個 々 是多餘的。
 *
 * ── 為什麼不是「換成前一個字的讀音」 ──────────────────────────
 * 那是最直覺的想法,但做不到:輸出到這一步已經是羅馬拼音了,
 * 「前一個字」是什麼字已經不知道。而回到原文去展開(時々 → 時時)
 * 在正常情況根本用不到(本來就轉得對),在壞掉的情況又會展開成
 * 更錯的東西(時時々 → 時時時)。
 *
 * ── 這不會妨礙使用者補讀音 ────────────────────────────────────
 * 補讀音的面板讀的是**原文**不是拼音,所以整個詞(含 々)都還選得到。
 *
 * 跟 stripProlongMarks 一樣**會改變字串長度**,所以同樣不可以併進
 * stripMacrons(那支必須維持長度,手動切分的索引靠它)。
 */
export function stripIterationMarks(text) {
  if (!ITERATION_MARK_GLOBAL.test(text)) {
    ITERATION_MARK_GLOBAL.lastIndex = 0; // 有 g 旗標,用完要歸零
    return text;
  }
  ITERATION_MARK_GLOBAL.lastIndex = 0;

  return text
    .replace(ITERATION_MARK_GLOBAL, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 這段文字裡有沒有需要轉換的日文? */
export function hasJapanese(text) {
  return JP_RE.test(text);
}

/**
 * 找出羅馬拼音結果裡「沒有被轉換、原樣留下來的日文」。
 *
 * 為什麼掃輸出就找得到:kuroshiro 的 mode:'spaced' 輸出就是
 * tokens.map(轉換).join(' ')。kuromoji 不認識的詞會完全沒有 reading,
 * kuroshiro 的 patchTokens 退而求其次拿 surface_form 當讀音,
 * 最後對不到假名表、把漢字原樣吐出來。
 *
 * 所以輸出裡每一段連續的日文字元,都精準對應一個轉換失敗的詞的原文,
 * 不需要去碰 kuroshiro 內部的 token 資料。
 *
 * @param {string} romaji kuroshiro 轉出來的結果
 * @returns {Array<{text: string, start: number, end: number}>}
 *          end 不含(exclusive);索引是對 romaji 這個字串本身
 */
export function findUnromanized(romaji) {
  // 整段都是標點的不算「沒轉出來」
  return findRuns(romaji, JP_RE_GLOBAL).filter(
    (run) => ![...run.text].every((char) => JP_PUNCT.test(char))
  );
}

/**
 * 找出平假名結果裡「沒有被讀出來、原樣留下來的漢字」。
 *
 * 跟 findUnromanized 是同一件事,只是判斷條件換成漢字 ——
 * 平假名模式的輸出本來就整片都是假名,那些不是錯誤。
 * 剩下的漢字才是 kuromoji 讀不出來的詞,也才是使用者該去補讀音的目標。
 *
 * 不必濾標點:漢字的碼位範圍裡本來就沒有標點。
 */
export function findUnreadKanji(kana) {
  return findRuns(kana, KANJI_RE_GLOBAL);
}

/**
 * 掃出所有符合 re 的連續字元段。
 *
 * 兩種偵測(拼音模式找日文、假名模式找漢字)只差在那個字元集合,
 * 合併邏輯完全一樣。分開寫的話,哪天改了合併規則就只會改到一邊。
 *
 * @returns {Array<{text: string, start: number, end: number}>} end 不含
 */
function findRuns(text, re) {
  if (!text) return [];

  const runs = [];
  let current = null;

  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const { index } = match;
    // 緊鄰前一個字元就併成同一段(同一個詞的原文)
    if (current && index === current.end) {
      current.end = index + match[0].length;
      current.text += match[0];
    } else {
      current = { text: match[0], start: index, end: index + match[0].length };
      runs.push(current);
    }
  }

  return runs;
}

/**
 * 把 findUnromanized 的位置(對羅馬拼音「字串」)換算成字母索引。
 *
 * 為什麼要換算:畫面上每個字母是一個 <span>,而那些 span 是把空白拿掉之後
 * 逐字產生的(見 splitter.js 的 splitRomaji)。所以字串位置跟 span 索引
 * 對不上,中間差了被拿掉的那些空白。
 *
 * @param {string} romaji 原始的轉換結果(含空白)
 * @param {Array<{text:string,start:number,end:number}>} runs findUnromanized 的結果
 * @returns {Array<{text:string,start:number,end:number}>} 改用字母索引的範圍
 */
export function toLetterRanges(romaji, runs) {
  if (!runs?.length) return [];

  // prefix[i] = romaji 前 i 個字元裡有幾個非空白字元
  const prefix = new Array(romaji.length + 1);
  let count = 0;
  for (let i = 0; i <= romaji.length; i += 1) {
    prefix[i] = count;
    if (i < romaji.length && !/\s/.test(romaji[i])) count += 1;
  }

  return runs
    .map((run) => ({
      text: run.text,
      start: prefix[run.start],
      end: prefix[run.end],
    }))
    .filter((run) => run.end > run.start);
}
