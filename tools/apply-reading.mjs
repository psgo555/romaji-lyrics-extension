#!/usr/bin/env node
/**
 * apply-reading.mjs
 * 把一則「補讀音」issue 的內容加進 dictionary.json。
 *
 * ── 這支存在的理由 ────────────────────────────────────────────
 * 回報進來之後,維護者要做的判斷只有一個:**這筆對不對、要收在哪一層**。
 * 那件事機器做不了。但「打開檔案、找到正確位置、貼上、別漏逗號、
 * 更新日期、commit」全部都是機器該做的 —— 而且是人最容易出錯的地方:
 * JSON 少一個逗號,整份字典就壞掉,所有使用者一起受影響。
 *
 * 所以把關的那一步留給人(貼 approved 標籤),手工的部分交給這支。
 *
 * ── 為什麼要用擴充功能自己的驗證器 ────────────────────────────
 * 因為「能不能寫進檔案」跟「使用者的瀏覽器會不會採用」必須是同一個標準。
 * 各寫一份的話,會出現「機器人說收好了、實際上所有人都拿不到」這種
 * 完全不會報錯的失敗 —— 而且要等到有人抱怨才會發現。
 *
 * 做法是:改好之後把整份丟回 parseSharedDictionary 跑一次,
 * 確認**新加的那一筆真的活下來**,活不下來就不寫檔。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSharedDictionary, normalizeSongTitle } from '../src/shared/shared-dictionary.js';

const DICTIONARY_PATH = new URL('../dictionary.json', import.meta.url);

/**
 * 從 issue 內文裡把欄位挖出來。
 *
 * 內文是擴充功能自動填的,格式固定 —— 這是這件事做得成的前提。
 * 但仍然寫得寬鬆一點(全形/半形冒號、前後空白、包不包反引號都吃),
 * 因為使用者送出前可以編輯,而多打一個空格不該讓整條路失敗。
 *
 * @param {string} body issue 的內文
 * @returns {{song: string, surface: string, reading: string, line: string}}
 */
export function parseIssueBody(body) {
  const pick = (label) => {
    const match = new RegExp(`^-\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, 'm').exec(body ?? '');
    if (!match) return '';
    // 反引號是排版用的,不是內容的一部分
    return match[1].replace(/^`+|`+$/g, '').trim();
  };

  const song = pick('曲名');

  return {
    // 擴充功能抓不到曲名時填的佔位字,不能當成真的曲名
    song: /^[(（]請補上[)）]$/.test(song) ? '' : song,
    surface: pick('原文'),
    reading: pick('讀音'),
    line: pick('這一句'),
  };
}

/** 今天(UTC)的 yyyy-mm-dd,跟 dictionary.json 的 updatedAt 同一種寫法 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 把一筆讀音加進字典。會就地修改傳進來的 dict。
 *
 * @param {object} dict 已經 JSON.parse 過的 dictionary.json
 * @param {object} options
 * @param {string} options.surface 原文
 * @param {string} options.reading 讀音(假名)
 * @param {string} [options.note] 出處,通常是曲名 + 這一句
 * @param {string} [options.song] 曲名;scope 為 'song' 時必填
 * @param {'global'|'song'} options.scope 收在通用層還是限定單曲
 * @returns {{ok: boolean, reason?: string, action?: string}}
 */
export function applyReading(dict, { surface, reading, note, song, scope }) {
  if (!surface || !reading) {
    return { ok: false, reason: 'issue 裡找不到「原文」或「讀音」,格式可能被改過了' };
  }

  const entry = { surface, reading, ...(note ? { note } : {}) };

  if (scope === 'global') {
    dict.entries ??= [];
    const at = dict.entries.findIndex((e) => e.surface === surface);
    if (at >= 0) dict.entries[at] = entry;
    else dict.entries.push(entry);

    dict.updatedAt = today();
    return { ok: true, action: at >= 0 ? '覆蓋既有的通用條目' : '新增通用條目' };
  }

  if (!song) {
    return {
      ok: false,
      reason: '沒有曲名,收不成限定單曲的條目(請在 issue 補上曲名,或改貼 global 標籤)',
    };
  }

  dict.songs ??= [];
  const key = normalizeSongTitle(song);
  let group = dict.songs.find((s) => normalizeSongTitle(s.title) === key);
  if (!group) {
    group = { title: song, entries: [] };
    dict.songs.push(group);
  }

  const at = group.entries.findIndex((e) => e.surface === surface);
  if (at >= 0) group.entries[at] = entry;
  else group.entries.push(entry);

  dict.updatedAt = today();
  return { ok: true, action: at >= 0 ? `覆蓋《${song}》既有的條目` : `新增《${song}》的條目` };
}

/**
 * 改完之後,用擴充功能自己的驗證器確認這一筆真的活得下來。
 *
 * 沒有這一步的話,像「只有一個々」這種條目會被寫進檔案、commit 成功、
 * 然後在每個使用者的瀏覽器裡被默默丟掉 —— 一路上不會有任何錯誤訊息。
 */
export function survivesValidation(dict, { surface, reading, song, scope }) {
  const parsed = parseSharedDictionary(dict);
  const list =
    scope === 'global' ? parsed.entries : (parsed.songs[normalizeSongTitle(song)] ?? []);
  return list.some((e) => e.surface === surface && e.reading === reading);
}

/* ------------------------------------------------------------ 給 CI 用 */

function main() {
  const body = process.env.ISSUE_BODY ?? '';
  const scope = process.env.SCOPE === 'global' ? 'global' : 'song';

  const { song, surface, reading, line } = parseIssueBody(body);
  const note = [song, line].filter(Boolean).join(' — ');

  const dict = JSON.parse(readFileSync(DICTIONARY_PATH, 'utf8'));
  const result = applyReading(dict, { surface, reading, note, song, scope });

  if (!result.ok) {
    fail(result.reason);
    return;
  }

  if (!survivesValidation(dict, { surface, reading, song, scope })) {
    // 擋下來的理由都寫在 shared-dictionary.js 的 isUsableEntry 裡
    fail(
      `「${surface} → ${reading}」沒通過字典的驗證,沒有寫入。` +
        '常見原因:讀音不是假名、或只選到疊字符(々 這類字要跟前面的字一起選)。'
    );
    return;
  }

  // 尾端保留換行,跟編輯器存出來的檔案一致,diff 才不會多一行雜訊
  writeFileSync(DICTIONARY_PATH, `${JSON.stringify(dict, null, 2)}\n`, 'utf8');
  succeed(`${result.action}:\`${surface}\` → \`${reading}\``);
}

function output(key, value) {
  // Actions 的多行輸出要用分隔符包起來,不然含換行的訊息會被截斷
  const file = process.env.GITHUB_OUTPUT;
  const text = `${key}<<__EOF__\n${value}\n__EOF__\n`;
  if (file) writeFileSync(file, text, { flag: 'a' });
  else process.stdout.write(`${key}=${value}\n`);
}

function succeed(message) {
  output('ok', 'true');
  output('message', message);
}

function fail(message) {
  output('ok', 'false');
  output('message', message);
  /*
   * 刻意**不**用非零離開碼。
   *
   * 這不是流程壞了,是這一筆不該收 —— 而使用者需要知道原因。
   * 讓後面的步驟照常跑完,才有辦法把理由回覆到 issue 上;
   * 直接讓工作失敗的話,他只會看到一個紅色叉叉,還要自己去翻 log。
   */
  console.warn(message);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
