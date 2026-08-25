/**
 * shared-dictionary.js
 * 驗證自網路取得的共用讀音字典。
 *
 * ── 本模組須特別嚴格的原因 ──────────────────────────────────
 * 這是整個專案中唯一會影響畫面、內容卻不由自身掌控的資料。
 * 它自 GitHub 取得,未攔妥時的損壞方式有兩種:
 *
 *   1. 格式損壞 → 轉換流程中斷,使用者連原本可用的拼音都失去
 *   2. 內容錯誤 → 畫面以確信的樣態顯示錯誤的拼音,而無人知其為錯
 *
 * 第二種更為嚴重。轉換失敗的字至少會原樣顯示,使用者看得出「這個沒轉」;
 * 但唸錯的拼音與正確的外觀完全相同。
 *
 * 故原則是:寧可整份捨棄,亦不放行可疑的內容。
 * 單筆有問題即跳過該筆,結構有問題則整份不採 —— 內建字典仍在,
 * 退回去只是少了新詞,不會損壞。
 *
 * 本模組不觸及 chrome 亦不連網,純資料驗證,可直接以 Node 測試。
 */

// 直接自 cjk 取用:繞經 reading.js 會將 wanakana 一併拖入背景程式
import { isValidReading, isIterationMarkOnly } from '../content/cjk.js';

/** 可辨識的格式版本。變更格式時一併修改此處,舊版擴充功能會自動忽略新格式。 */
export const SUPPORTED_VERSION = 1;

/*
 * ── 加入 songs 卻不推進版本號的原因 ───────────────────────────
 * songs 是一個新的頂層欄位,舊版擴充功能只讀 entries、根本不會看它,
 * 因此舊版取得新檔案仍然完全正確 —— 僅是少了限定單曲的那些條目。
 *
 * 推進版本號反而更糟:舊版的規則是「無法辨識的版本整份不採」,
 * 那會使所有尚未更新的使用者連原本可用的全域條目也一併失去。
 *
 * 判斷標準是舊版會不會做出錯誤的事,而非「格式有沒有變」。
 * 日後若要變更的是 entries 本身的意義,屆時才非推進版本號不可。
 */

/*
 * 數量與長度上限。
 *
 * 並非顧慮檔案大小,而是顧慮出事的情況:萬一有一筆 surface 長達數萬字,
 * applyCorrectionsWith 是對每個位置取整張表比對的,那會使每一行歌詞
 * 都慢下來,而使用者只會覺得「這個擴充功能很卡」,查不出原因。
 */
const MAX_ENTRIES = 5000;
const MAX_SURFACE_LENGTH = 40;
const MAX_READING_LENGTH = 60;

/** 限定單曲的條目:理由相同,僅是分成兩層設限 */
const MAX_SONGS = 2000;
const MAX_ENTRIES_PER_SONG = 200;
const MAX_TITLE_LENGTH = 200;

/**
 * 曲名的比對用寫法。
 *
 * ── 只看曲名而不看歌手的原因 ────────────────────────────────
 * 為使翻唱版能套用同一筆修正。同一首歌換人演唱,歌詞相同,
 * 讀錯的字也會相同 —— 綁上歌手等於每個版本都須有人再回報一次。
 *
 * 撞名的風險很小:條目要生效,除曲名相同外,該詞還須確實出現在
 * 這首歌的歌詞中。兩首同名的歌又恰好含同一個詞才會誤中,
 * 而即使誤中,影響亦僅限於那一首歌,不似全域條目會波及所有人所有歌。
 */
export function normalizeSongTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 將取得的內容驗證成一份可用的修正表。
 *
 * @param {unknown} raw 已經 JSON.parse 過的內容
 * @returns {{ entries: Array<{surface: string, reading: string}>,
 *             songs: Record<string, Array<{surface: string, reading: string}>>,
 *             skipped: number }}
 *          結構有問題時 entries 與 songs 皆為空 —— 呼叫端即退回內建字典
 */
export function parseSharedDictionary(raw) {
  const empty = { entries: [], songs: {}, skipped: 0 };

  if (!raw || typeof raw !== 'object') return empty;
  if (raw.version !== SUPPORTED_VERSION) return empty; // 無法辨識的版本整份不採
  if (!Array.isArray(raw.entries)) return empty;

  const entries = [];
  const seen = new Set();
  let skipped = 0;

  for (const item of raw.entries.slice(0, MAX_ENTRIES)) {
    if (!isUsableEntry(item, seen)) {
      skipped += 1;
      continue;
    }
    seen.add(item.surface);
    // 僅保留需要的兩個欄位 —— note 是給人閱讀的,不應流入轉換流程
    entries.push({ surface: item.surface, reading: item.reading });
  }

  // 超出上限而被截去的那些同樣計入跳過,數字才誠實
  skipped += Math.max(0, raw.entries.length - MAX_ENTRIES);

  const songs = parseSongs(raw.songs, (n) => {
    skipped += n;
  });

  return { entries, songs, skipped };
}

/**
 * 限定單曲的條目。
 *
 * ── 需要這一層的原因 ──────────────────────────────────────
 * 回報者無從判斷一筆修正在其他歌曲中是否安全。
 * 「失 → な」在某首歌是正確的,可是一旦全域生效,失敗便會變成なはい。
 * 要求每位回報者都想清楚此事,等於此功能僅有懂日文者能使用。
 *
 * 綁在一首歌上則毋須判斷:即使錯誤亦僅錯那一首,而同一首歌的其他使用者
 * 可直接取得修正後的結果,不必逐一再修一次 —— 那正是共用字典的意義。
 *
 * 全域條目仍然保留,供「不論哪首歌都應如此讀」的詞使用(人名、固定讀法)。
 *
 * @param {unknown} raw dictionary.json 的 songs 欄位;缺少時視為空
 * @param {(count: number) => void} countSkipped 將跳過的筆數回報給呼叫端
 * @returns {Record<string, Array<{surface: string, reading: string}>>}
 */
function parseSongs(raw, countSkipped) {
  if (!Array.isArray(raw)) return {}; // 缺少此欄位屬正常情形,並非錯誤

  const songs = {};

  for (const song of raw.slice(0, MAX_SONGS)) {
    if (!song || typeof song !== 'object') {
      countSkipped(1);
      continue;
    }

    const title = normalizeSongTitle(song.title);
    if (!title || title.length > MAX_TITLE_LENGTH || !Array.isArray(song.entries)) {
      countSkipped(Array.isArray(song.entries) ? song.entries.length : 1);
      continue;
    }

    // 同一首歌出現兩次時合併其條目,不使後者整個覆蓋前者
    const list = songs[title] ?? [];
    const seen = new Set(list.map((e) => e.surface));

    for (const item of song.entries.slice(0, MAX_ENTRIES_PER_SONG)) {
      if (!isUsableEntry(item, seen)) {
        countSkipped(1);
        continue;
      }
      seen.add(item.surface);
      list.push({ surface: item.surface, reading: item.reading });
    }

    countSkipped(Math.max(0, song.entries.length - MAX_ENTRIES_PER_SONG));
    if (list.length) songs[title] = list;
  }

  countSkipped(Math.max(0, raw.length - MAX_SONGS));
  return songs;
}

/**
 * 該筆是否可用。
 * 每一項檢查都是為了擋下一種具體的損壞方式,並非形式上的檢查。
 */
function isUsableEntry(item, seen) {
  if (!item || typeof item !== 'object') return false;

  const { surface, reading } = item;
  if (typeof surface !== 'string' || typeof reading !== 'string') return false;
  if (!surface || !reading) return false;

  if (surface.length > MAX_SURFACE_LENGTH) return false;
  if (reading.length > MAX_READING_LENGTH) return false;

  // 同一個原文出現兩次時以先出現者為準,不使後者無聲覆蓋
  if (seen.has(surface)) return false;

  /*
   * 僅含疊字符(々 之類)的條目一律擋下。
   *
   * 其讀音完全取決於前一個字(時々=ときどき、人々=ひとびと),
   * 單獨指定一個讀音必然破壞其他所有含它的詞 —— 且是破壞所有使用者的。
   *
   * 面板已擋了一層,但此處是資料層:有人直接送 PR 修改這個檔案時,
   * 面板的防護毫無作用。兩處皆須攔下。
   */
  if (isIterationMarkOnly(surface)) return false;

  /*
   * reading 必須為假名 —— 僅有一個例外:寫成與 surface 相同代表
   * 「原樣放過」,那是守衛條目的用法(見 一人称)。
   *
   * 缺少這道檢查時,若有人填入漢字或英文,轉換結果會混有未轉換的內容,
   * 且因其已進入修正表,該錯誤會覆蓋 kuromoji 本來正確的判斷。
   */
  if (reading === surface) return true;
  return isValidReading(reading);
}
