#!/usr/bin/env node
/**
 * apply-reading.mjs
 * 將一則「補讀音」issue 的內容加入 dictionary.json。
 *
 * ── 本工具存在的理由 ──────────────────────────────────────────
 * 回報進來之後,維護者要做的判斷只有一項:這一筆是否正確、應收在哪一層。
 * 那件事機器做不到。但「開啟檔案、找到正確位置、貼上、勿漏逗號、
 * 更新日期、commit」全屬機器應做之事 —— 且是人最容易出錯之處:
 * JSON 少一個逗號,整份字典即損壞,所有使用者一併受影響。
 *
 * 故把關那一步留給人(貼上 approved 標籤),手工的部分交由本工具。
 *
 * ── 使用擴充功能自身驗證器的原因 ──────────────────────────────
 * 因為「能否寫入檔案」與「使用者的瀏覽器是否會採用」必須是同一個標準。
 * 各寫一份的話,會出現「機器人回報已收錄、實際上所有人都取不到」這種
 * 完全不會報錯的失敗 —— 且須等到有人抱怨才會發現。
 *
 * 作法是:修改完成後將整份丟回 parseSharedDictionary 執行一次,
 * 確認新加入的那一筆確實存活,未能存活即不寫檔。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSharedDictionary, normalizeSongTitle } from '../src/shared/shared-dictionary.js';

const DICTIONARY_PATH = new URL('../dictionary.json', import.meta.url);

/**
 * 自 issue 內文中取出各欄位。
 *
 * 內文由擴充功能自動填入,格式固定 —— 這是本流程得以成立的前提。
 * 但仍寫得寬鬆(全形與半形冒號、前後空白、有無反引號皆可接受),
 * 因為使用者於送出前可以編輯,而多打一個空格不應使整條流程失敗。
 *
 * @param {string} body issue 的內文
 * @returns {{song: string, surface: string, reading: string, line: string}}
 */
export function parseIssueBody(body) {
  const pick = (label) => {
    const match = new RegExp(`^-\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, 'm').exec(body ?? '');
    if (!match) return '';
    // 反引號屬排版用途,不是內容的一部分
    return match[1].replace(/^`+|`+$/g, '').trim();
  };

  const song = pick('曲名');

  return {
    // 擴充功能取不到曲名時填入的佔位字,不可視為真正的曲名
    song: /^[(（]請補上[)）]$/.test(song) ? '' : song,
    surface: pick('原文'),
    reading: pick('讀音'),
    line: pick('這一句'),
  };
}

/** 今日(UTC)的 yyyy-mm-dd,與 dictionary.json 的 updatedAt 採同一種寫法 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 將一筆讀音加入字典。會就地修改傳入的 dict。
 *
 * @param {object} dict 已經 JSON.parse 過的 dictionary.json
 * @param {object} options
 * @param {string} options.surface 原文
 * @param {string} options.reading 讀音(假名)
 * @param {string} [options.note] 出處,通常為曲名加上該句歌詞
 * @param {string} [options.song] 曲名;scope 為 'song' 時必填
 * @param {'global'|'song'} options.scope 收在通用層或限定單曲
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
 * 修改完成後,以擴充功能自身的驗證器確認這一筆確實存活。
 *
 * 缺少這一步時,像「僅含一個々」這類條目會被寫入檔案、commit 成功,
 * 然後在每個使用者的瀏覽器中被無聲丟棄 —— 全程不會有任何錯誤訊息。
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
    // 攔下的理由皆記載於 shared-dictionary.js 的 isUsableEntry
    fail(
      `「${surface} → ${reading}」沒通過字典的驗證,沒有寫入。` +
        '常見原因:讀音不是假名、或只選到疊字符(々 這類字要跟前面的字一起選)。'
    );
    return;
  }

  // 尾端保留換行,與編輯器存出的檔案一致,diff 才不會多出一行雜訊
  writeFileSync(DICTIONARY_PATH, `${JSON.stringify(dict, null, 2)}\n`, 'utf8');
  succeed(`${result.action}:\`${surface}\` → \`${reading}\``);
}

function output(key, value) {
  // Actions 的多行輸出須以分隔符包覆,否則含換行的訊息會被截斷
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
   * 刻意不使用非零離開碼。
   *
   * 這並非流程損壞,而是這一筆不該收錄 —— 且使用者需要知道原因。
   * 讓後續步驟照常執行完畢,才有辦法將理由回覆至 issue 上;
   * 直接令工作失敗的話,他只會看到一個紅色叉叉,還須自行翻查 log。
   */
  console.warn(message);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
