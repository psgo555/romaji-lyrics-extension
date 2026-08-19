/**
 * macron.js
 * 長音符(macron)的處理,集中在這裡一份。
 *
 * 為什麼要獨立成一支:
 * romaji.js 轉換時要拿掉長音符,splitter.js 比對舊的切分資料時
 * 也要用同一套規則(舊資料是拿掉長音符之前存的,含 ō ē)。
 * 兩邊各寫一份,哪天改了其中一邊,舊切分就會無聲無息地全部失效 ——
 * 而且那種壞法不會噴錯,只會讓使用者覺得自己的設定莫名其妙消失。
 *
 * 這支不 import 任何東西、也沒有 module-level 副作用,
 * 所以 splitter.js 可以安心用,不會把 kuroshiro 一起拖進來。
 */

/*
 * 組合用長音符 U+0304。
 *
 * 刻意用碼位而不是直接把那個字元寫進原始碼:組合字元單獨出現時
 * 在編輯器裡是看不見的,很容易在編輯或複製貼上時被弄丟,
 * 而且壞掉之後從程式碼上完全看不出來。
 */
const COMBINING_MACRON = String.fromCharCode(0x0304);

/**
 * 拿掉長音符:ā ī ū ē ō → a i u e o
 *
 * kuroshiro 預設是 Hepburn 式,長音會標成 ō / ē 這種頭上一橫的字元。
 * 那一橫在畫面上看起來就是「拼音上面多了一條線」,跟唱時只是干擾。
 *
 * 為什麼用正規化而不是逐字對照表:
 * NFD 會把 ō 拆成「o + 組合用長音符(U+0304)」,刪掉那個組合字元即可 ——
 * 五個母音、大小寫全部涵蓋,而且不管 kuroshiro 吐的是預組合字元
 * 還是組合序列都吃得到。
 *
 * **長度不變**(1 個字元換 1 個字元)。這一點是 splitter.js 能沿用
 * 舊切分的前提:切點是字母索引,長度一變索引就會落在錯的位置。
 * 改這個函式的時候務必守住這個性質。
 *
 * 代價:長音的資訊沒了(`ō` 與 `o` 變成一樣)。這是刻意的取捨 ——
 * 跟唱時要的是好讀,不是嚴謹的轉寫。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMacrons(text) {
  return text.normalize('NFD').split(COMBINING_MACRON).join('').normalize('NFC');
}
