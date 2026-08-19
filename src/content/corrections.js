/**
 * corrections.js
 *
 * 自定義讀音修正字典。
 * kuromoji 的內建辭典(IPADIC)對某些常見組合詞、固定讀法的詞彙
 * 會給出「技術上可能但語境上不對」的讀音(例如把詞拆開,用最常見的
 * 單字讀音去拼,而不是整個詞當作固定讀法)。
 *
 * 這張表列出目前已知會被讀錯的詞,surface 是原文(漢字),
 * reading 是正確的讀音(平假名)。
 *
 * 原理:在丟給 kuroshiro 轉換之前,先把這些詞用字串取代成
 * 正確的平假名讀音——因為 kuroshiro 對已經是平假名的部分
 * 不會再重新判斷讀音,會直接透過 wanakana 轉羅馬拼音,
 * 所以「取代成正確讀音」就能繞過 kuromoji 誤判的問題,
 * 不需要動到 kuromoji 內部字典。
 *
 * 新增修正詞:直接在 CORRECTIONS 陣列加一筆即可,不必自己排序——
 * 下面會自動依原文長度由長到短排序,確保長詞優先比對
 * (例如遇到 "二人組" 這種包含 "二人" 的更長詞彙時,會先比對整個 "二人組")。
 */

export const CORRECTIONS = [
  // 「響めき」kuromoji 預設拆成「響(ひびき)」+「めき」,
  // 但整個詞是固定讀法「どよめき」(轟然作響/騷動)
  { surface: '響めき', reading: 'どよめき' },

  // 「二人」kuromoji 有時會拆成「二(に)」+「人(にん)」讀成「ににん」,
  // 但一般語境下幾乎都唸「ふたり」,此詞在歌詞中極高頻,優先修正
  { surface: '二人', reading: 'ふたり' },

  // 「一人」同上,kuromoji 讀成「いちにん」,一般語境是「ひとり」。
  // 順帶也修好「一人一人」—— 取代後變成「ひとりひとり」,剛好是對的。
  { surface: '一人', reading: 'ひとり' },

  // 守衛條目:「一人称」kuromoji 本來就讀對(ichininshō),
  // 但上面的「一人」會鑽進去把它變成「ひとり称」而弄壞。
  //
  // reading 寫成跟 surface 一樣,意思是「原樣保留、不要動它」——
  // 因為比對到就會把這一段消耗掉,後面的短詞就進不來了。
  // 注意不能改寫成假名:kuromoji 對「いちにんしょう」反而會拆成
  // ichi ni n shō,比原本更糟。讀音本來就對的詞,原樣放過才是對的。
  { surface: '一人称', reading: '一人称' },

  /*
   * 這一筆示範「行內振假名」的處理方式,是這個資料來源很常見的寫法。
   *
   * Spotify 有些歌詞會把讀音直接以純文字寫在漢字後面(不是 <ruby> 標記),
   * 例如原文實際上是「藻掻もがいて」—— 漢字後面跟著它自己的讀音。
   *
   * 所以 surface 要把**漢字連同重複的那段假名一起**涵蓋進來,
   * reading 只留假名。只寫「藻掻 → もが」的話,後面本來就有的「もが」
   * 會被留下來,變成 mo ga mogai te(讀音被唸了兩次)。
   *
   * 使用者自己遇到這種情況時,在補讀音的面板裡把選取範圍拉到
   * 「漢字 + 後面重複的假名」,再輸入那段假名即可,原理相同。
   */
  { surface: '藻掻もが', reading: 'もが' },
]
  // 依原文長度由長到短排序,確保長詞優先比對
  .sort((a, b) => b.surface.length - a.surface.length);

/**
 * 在丟給 kuroshiro 轉換之前,先做讀音修正的文字取代。
 * @param {string} text 原始歌詞行(可能含漢字)
 * @returns {string} 已修正已知錯誤讀音的文字(修正處已變成平假名)
 */
/** 依原文長度由長到短排序,確保長詞優先比對 */
export function sortCorrections(list) {
  return [...list].sort((a, b) => b.surface.length - a.surface.length);
}

/*
 * 實際生效的那份表 = 內建的 + 使用者自己加的。
 *
 * 使用者的部分由 corrections-store.js 從 chrome.storage 載入後灌進來。
 * 這支檔案本身刻意不碰 chrome API —— legacy/test-corrections.js
 * 是用 Node 直接匯入它的,一旦相依 chrome 那個測試就跑不動了。
 */
let activeList = sortCorrections(CORRECTIONS);

export function setActiveCorrections(list) {
  activeList = sortCorrections(list);
}

export function getActiveCorrections() {
  return activeList;
}

/** 用指定的表做修正。預覽功能要拿「還沒存檔的那筆」試轉,所以需要這個。 */
export function applyCorrectionsWith(text, list) {
  let result = '';
  let index = 0;

  // 從左到右掃一次,每個位置都拿整張表(已按長度排序)去試。
  //
  // 為什麼不用逐條 split/join 全域取代:那樣做每一條都會掃過整個字串,
  // 短詞會鑽進已經被長詞處理過的地方。例如「一人」會鑽進「一人称」裡,
  // 把本來就正確的詞弄壞成「ひとり称」。
  // 改成比對到就把那一段**消耗掉**,長詞才真的保護得住短詞。
  outer: while (index < text.length) {
    for (const { surface, reading } of list) {
      if (!text.startsWith(surface, index)) continue;
      result += reading;
      index += surface.length;
      continue outer;
    }
    result += text[index];
    index += 1;
  }

  return result;
}

/** 用目前生效的表(內建 + 使用者自訂)做修正 */
export function applyCorrections(text) {
  return applyCorrectionsWith(text, activeList);
}
