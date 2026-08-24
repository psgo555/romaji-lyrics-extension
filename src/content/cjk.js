/**
 * cjk.js
 * 日文字元的判定規則,集中於單一模組。
 *
 * 獨立為模組的兩項原因:
 *
 *   1. romaji.js 的「此行是否需要轉換」與「哪些字未轉出」屬同一項判斷,
 *      規則分散於兩處終將產生分歧
 *   2. 原先的寫法將邊界字元直接寫入正規表達式,須仰賴每個編輯器與工具鏈
 *      正確地來回轉換 UTF-8 才不致損壞。改用 \uXXXX 逃脫字元後不受此影響,
 *      並可直接標示所屬的 Unicode 區塊
 *
 * 涵蓋範圍較舊版增加數段,皆為實際會遇到的字元:
 *
 *   U+3005 々(人々、時々)、U+3006 〆、U+303B 〻
 *   U+F900–FAFF 相容漢字 —— kuroshiro 自身的 isKanji 含此段,舊版判斷未含,
 *                          等同於引擎能轉換而我們不允許其轉換
 *   U+FF66–FF9F 半形片假名
 *   U+20000 以上的擴充漢字(須搭配 u flag)
 */

/**
 * 判定為需要轉換的日文字元集合。
 * 不含標點,標點見下方的 JP_PUNCT。
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
 * 僅含漢字的子集合(不含假名)。
 *
 * 供平假名注音模式使用:該模式的輸出整體為假名,以 JP_CHAR 掃描會將每個字
 * 判定為未轉出而整行標紅。該模式下真正未轉出的是原樣保留的漢字,
 * 判斷條件因而須換為另一組。
 */
export const KANJI_CHAR =
  '\\u3005\\u3006\\u303b' + // 々〆〻(疊字符,讀音取決於前一個字)
  '\\u3400-\\u4dbf' + // CJK 擴充 A
  '\\u4e00-\\u9fff' + // CJK 基本區
  '\\uf900-\\ufaff' + // CJK 相容漢字
  '\\u{20000}-\\u{2ebef}' + // CJK 擴充 B/C/D/E/F
  '\\u{2f800}-\\u{2fa1f}'; // CJK 相容補充

/** 單一字元的判定,供 hasJapanese 使用 */
const JP_RE = new RegExp(`[${JP_CHAR}]`, 'u');

/** 全域版本,供掃描使用。帶有 lastIndex 狀態,不對外提供。 */
const JP_RE_GLOBAL = new RegExp(`[${JP_CHAR}]`, 'gu');
const KANJI_RE_GLOBAL = new RegExp(`[${KANJI_CHAR}]`, 'gu');

/**
 * 會合法留存於羅馬拼音輸出中的日文標點。
 * kuroshiro 不會將其轉為英文標點,留在結果中屬正常現象,
 * 未轉出字元的偵測必須排除,否則會大量誤標。
 *
 * 刻意不納入 JP_CHAR:整行僅有標點時,不應被視為需要轉換的日文。
 */
export const JP_PUNCT = /[　-〄〇-〺〼-〿・｡-･]/u;

/**
 * 疊字符,表示重複前一個字,本身沒有固定讀音。
 *
 *   々  漢字用(時々、人々)
 *   〻  漢字用的直式變體
 *   ゝゞ 平假名用
 *   ヽヾ 片假名用
 *   〃  同上符號
 */
const ITERATION_MARKS = /^[々〻ゝゞヽヾ〃]+$/u;

/**
 * 判定該段文字是否僅由疊字符構成。
 *
 * 疊字符的讀音完全取決於其前方的字:
 *
 *   時々 → ときどき   々 讀 どき
 *   人々 → ひとびと   々 讀 びと
 *   様々 → さまざま   々 讀 ざま
 *   日々 → ひび       々 讀 び
 *
 * 因此單獨為 々 指定讀音在定義上即為錯誤:無論填入何值,其餘所有含 々 的詞
 * 都會因而損壞。
 *
 * 修正面板上容易踩到此情況:未轉出的字元正是 々,使用者會直覺地為其補讀音。
 * 實際發生過(「時時々」,使用者嘗試填入 々=どき);該筆若進入共用字典,
 * 人々 會變為 ひとどき,影響所有使用者。
 *
 * 正確作法是將選取範圍擴及整個詞後再補讀音。
 */
export function isIterationMarkOnly(text) {
  return ITERATION_MARKS.test(text ?? '');
}

/** 單一疊字符的比對,供下方的清除函式使用 */
const ITERATION_MARK_GLOBAL = /[々〻ゝゞヽヾ〃]/gu;

/**
 * 移除殘留至羅馬拼音輸出中的疊字符。
 *
 * 疊字符表示重複前一個字,因而必然是某個詞的一部分。轉換正常時它會與前方的字
 * 一併處理,不會出現於結果中(時々 → tokidoki、人々 → hitobito、様々 → samazama、
 * 日々 → hibi,實測皆不需要任何字典條目)。
 *
 * 反之,它若原樣留存於輸出中,即表示未配對到任何內容,多半源於歌詞來源的輸入
 * 錯誤(例如「時時々」多打一個「時」,留下孤立的 々)。此時移除才是正確處理:
 * 前方的字已正確轉出,該 々 屬多餘。
 *
 * 不採「替換為前一個字的讀音」:輸出至此已為羅馬拼音,前一個字為何已無從得知。
 * 而回到原文展開(時々 → 時時)在正常情況下並無用武之地(本即轉換正確),
 * 在異常情況下則會展開為更錯誤的結果(時時々 → 時時時)。
 *
 * 此處理不影響使用者補讀音:修正面板讀取的是原文而非拼音,整個詞(含 々)
 * 仍可選取。
 *
 * 與 stripProlongMarks 相同,本函式會改變字串長度,因而同樣不可併入 stripMacrons
 * (該函式必須維持長度,手動斷字的索引依賴此性質)。
 */
export function stripIterationMarks(text) {
  if (!ITERATION_MARK_GLOBAL.test(text)) {
    ITERATION_MARK_GLOBAL.lastIndex = 0; // 帶有 g 旗標,使用後須歸零
    return text;
  }
  ITERATION_MARK_GLOBAL.lastIndex = 0;

  return text
    .replace(ITERATION_MARK_GLOBAL, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 讀音僅接受假名與長音符,混入漢字等同於未完成修正。
 *
 * 置於此處是因其本質為字元分類(該字串是否全為假名),與本模組其他判斷同類。
 *
 * 且本模組不 import 任何項目,背景程式與共用字典的驗證因而可僅取用此項判斷,
 * 不會連帶打包整套羅馬拼音轉換工具。先前它與 toKanaReading 置於同一模組,
 * 使 service worker 自 3.4kb 增至 14.3kb。
 */
export const READING_PATTERN = /^[ぁ-ゟ゠-ヿー]+$/u;

export function isValidReading(reading) {
  return READING_PATTERN.test(reading ?? '');
}

/** 該段文字是否含有需要轉換的日文 */
export function hasJapanese(text) {
  return JP_RE.test(text);
}

/**
 * 找出羅馬拼音結果中未經轉換、原樣留存的日文。
 *
 * 掃描輸出即可取得的原因:kuroshiro 的 mode:'spaced' 輸出即為
 * tokens.map(轉換).join(' ')。kuromoji 無法辨識的詞完全沒有 reading,
 * kuroshiro 的 patchTokens 退而以 surface_form 作為讀音,最終對不到假名表,
 * 將漢字原樣輸出。
 *
 * 輸出中每一段連續的日文字元,因而精準對應一個轉換失敗的詞的原文,
 * 無須存取 kuroshiro 內部的 token 資料。
 *
 * @param {string} romaji kuroshiro 的轉換結果
 * @returns {Array<{text: string, start: number, end: number}>}
 *          end 不含;索引相對於 romaji 字串本身
 */
export function findUnromanized(romaji) {
  // 整段皆為標點者不計為未轉出
  return findRuns(romaji, JP_RE_GLOBAL).filter(
    (run) => ![...run.text].every((char) => JP_PUNCT.test(char))
  );
}

/**
 * 找出平假名結果中未讀出、原樣留存的漢字。
 *
 * 與 findUnromanized 為同一件事,僅將判斷條件換為漢字 —— 平假名模式的輸出
 * 本即整體為假名,該部分並非錯誤。餘下的漢字才是 kuromoji 無法讀出的詞,
 * 亦即使用者應補讀音的目標。
 *
 * 無須過濾標點:漢字的碼位範圍內不含標點。
 */
export function findUnreadKanji(kana) {
  return findRuns(kana, KANJI_RE_GLOBAL);
}

/**
 * 掃描出所有符合 re 的連續字元段。
 *
 * 兩種偵測(拼音模式找日文、假名模式找漢字)僅字元集合不同,合併邏輯完全一致。
 * 分開實作時,合併規則的變更只會套用至其中一方。
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
    // 與前一個字元相鄰即併入同一段(屬同一個詞的原文)
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
 * 將 findUnromanized 的字串位置換算為字母索引。
 *
 * 畫面上每個字母為一個 <span>,而這些 span 是移除空白後逐字產生的
 * (見 splitter.js 的 splitRomaji)。字串位置與 span 索引因而不一致,
 * 差距即為被移除的空白。
 *
 * @param {string} romaji 原始轉換結果(含空白)
 * @param {Array<{text:string,start:number,end:number}>} runs findUnromanized 的結果
 * @returns {Array<{text:string,start:number,end:number}>} 改以字母索引表示的範圍
 */
export function toLetterRanges(romaji, runs) {
  if (!runs?.length) return [];

  // prefix[i] = romaji 前 i 個字元中非空白字元的數量
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
