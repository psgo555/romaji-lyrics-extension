/**
 * corrections.js
 * 自訂讀音修正字典。
 *
 * kuromoji 的內建辭典(IPADIC)對部分常見組合詞與固定讀法會給出技術上可能、
 * 但語境上錯誤的讀音 —— 典型情況是將詞拆開,以各單字最常見的讀音拼合,
 * 而非將整個詞視為固定讀法。
 *
 * 本表列出目前已知會被讀錯的詞:surface 為原文(漢字),reading 為正確讀音(平假名)。
 *
 * 原理:送入 kuroshiro 轉換前,先將這些詞以字串替換為正確的平假名讀音。
 * kuroshiro 對已是平假名的部分不會重新判斷讀音,而是直接經 wanakana 轉為羅馬拼音,
 * 替換因而可繞過 kuromoji 的誤判,無須改動 kuromoji 內部字典。
 *
 * 新增條目:於 CORRECTIONS 陣列加入一筆即可,無須自行排序 —— 下方會依原文長度
 * 由長至短排序,確保長詞優先比對(例如「二人組」會先於其所包含的「二人」被比對到)。
 */

export const CORRECTIONS = [
  // 「響めき」kuromoji 預設拆為「響(ひびき)」+「めき」,
  // 但整個詞為固定讀法「どよめき」(轟然作響、騷動)
  { surface: '響めき', reading: 'どよめき' },

  // 「二人」kuromoji 有時拆為「二(に)」+「人(にん)」而讀成「ににん」,
  // 但一般語境幾乎皆讀「ふたり」。此詞於歌詞中出現頻率極高,優先修正
  { surface: '二人', reading: 'ふたり' },

  // 「一人」同上,kuromoji 讀為「いちにん」,一般語境為「ひとり」。
  // 一併修正「一人一人」—— 替換後為「ひとりひとり」,結果正確。
  { surface: '一人', reading: 'ひとり' },

  // 守衛條目:「一人称」kuromoji 本即讀對(ichininshō),
  // 但上方的「一人」會侵入並將其破壞為「ひとり称」。
  //
  // reading 與 surface 相同,表示原樣保留 —— 比對命中即會消耗該段,
  // 後方的短詞因而無法侵入。
  // 不可改寫為假名:kuromoji 對「いちにんしょう」反而會拆為 ichi ni n shō,
  // 較原本更差。讀音本即正確的詞,原樣放行才是正確處理。
  { surface: '一人称', reading: '一人称' },

  /*
   * 本筆示範行內振假名的處理方式,為此資料來源常見的寫法。
   *
   * Spotify 部分歌詞會將讀音以純文字直接寫於漢字之後(而非 <ruby> 標記),
   * 亦即漢字後方跟隨其自身的讀音。
   *
   * surface 因而須涵蓋漢字連同其後重複的假名,reading 僅留假名。
   * 若僅寫「藻掻 → もが」,後方原有的假名會留存,讀音因而被唸兩次。
   *
   * 使用者遇到此情況時,於修正面板將選取範圍拉至「漢字 + 後方重複的假名」,
   * 再輸入該段假名即可,原理相同。
   */
  { surface: '藻掻もが', reading: 'もが' },

  /*
   * 「心の臓」為心臟的文言說法,固定讀 しんのぞう。
   *
   * kuromoji 於此處犯了兩個疊加的錯誤:「心」被視為獨立的詞而讀為 こころ,
   * 「臓」則完全無法讀出、原樣輸出。
   *
   * surface 必須是整個詞。僅補「臓 → ぞう」時前半段仍為錯誤 —— 這正是修正面板
   * 要求涵蓋整個詞的原因。
   *
   * 實測曲目:RADWIMPS〈すずめ〉
   */
  { surface: '心の臓', reading: 'しんのぞう' },

  /*
   * 「熄む」(やむ)為熄滅、止息,此處收錄的是連用形「熄み」。
   *
   * 不寫為「熄 → や」的原因:該字於其他詞中讀 そく(熄滅 = そくめつ),
   * 單字替換會一併破壞那些詞。收錄整個詞才安全 —— 本表的規則一貫為長詞優先,
   * 比對命中即消耗該段。
   *
   * 實測曲目:RADWIMPS〈すずめ〉
   */
  { surface: '熄み', reading: 'やみ' },
]
  // 依原文長度由長至短排序,確保長詞優先比對
  .sort((a, b) => b.surface.length - a.surface.length);

/** 依原文長度由長至短排序,確保長詞優先比對 */
export function sortCorrections(list) {
  return [...list].sort((a, b) => b.surface.length - a.surface.length);
}

/*
 * 實際生效的表 = 內建條目 + 使用者自訂條目。
 *
 * 使用者的部分由 corrections-store.js 自 chrome.storage 載入後寫入。
 * 本模組刻意不觸及 chrome API —— legacy/test-corrections.js 以 Node 直接匯入,
 * 一旦相依 chrome,該測試即無法執行。
 */
let activeList = sortCorrections(CORRECTIONS);

export function setActiveCorrections(list) {
  activeList = sortCorrections(list);
}

export function getActiveCorrections() {
  return activeList;
}

/** 以指定的表進行修正。預覽功能須以尚未存檔的條目試轉,因而需要此介面。 */
export function applyCorrectionsWith(text, list) {
  let result = '';
  let index = 0;

  // 自左至右掃描一次,每個位置皆以整張表(已依長度排序)嘗試比對。
  //
  // 不採逐條 split/join 全域替換的原因:該作法每一條都會掃過整個字串,
  // 短詞會侵入已由長詞處理過的位置。例如「一人」會侵入「一人称」,
  // 將本即正確的詞破壞為「ひとり称」。
  // 改為比對命中即消耗該段後,長詞才真正能保護短詞。
  outer: while (index < text.length) {
    for (const { surface, reading } of list) {
      /*
       * 空字串的原文必須擋下,否則此迴圈永遠不會結束。
       *
       * startsWith('') 恆為 true,而 index += 0 —— 每一圈都會將 reading 再次
       * 接於 result 之後,字串無限增長,分頁隨即 Out of Memory。
       *
       * 此情況並非假設:修正面板以雙擊開啟時選取範圍預設為空,使用者一邊輸入
       * 讀音一邊即時預覽,「空原文 + 合法讀音」的組合即會走到此處。
       * 實際發生過,整個 Spotify 分頁當機。
       *
       * 呼叫端亦設有一層防護,但此處才是能保證迴圈前進的位置 —— 上層漏掉任何
       * 一條路徑,症狀都是當機而非顯示錯誤訊息。
       */
      if (!surface) continue;
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

/**
 * 以目前生效的表(內建 + 使用者自訂)進行修正。
 * 於送入 kuroshiro 轉換前呼叫。
 *
 * @param {string} text 原始歌詞行(可能含漢字)
 * @returns {string} 已修正已知錯誤讀音的文字,修正處為平假名
 */
export function applyCorrections(text) {
  return applyCorrectionsWith(text, activeList);
}
