/**
 * check-imports.mjs
 * 漏 import 的靜態掃描。
 *
 * 需要本工具的原因:
 * esbuild 對「未定義的全域識別字」不報錯,build 階段攔不到;
 * 而「以 vm 執行 dist/content.js」的煙霧測試只跑到模組載入,抓不到
 * 僅在某條分支才會呼叫到的漏 import(例如只有擴充功能被重新載入時
 * 才執行的 shutdown())。本專案已因漏 import 崩潰過三次。
 *
 * 作法:先收集所有模組 export 了哪些名稱,再對每支模組找出
 * 「用到了其他模組的 export 名稱、但自身既未 import 亦未在本地宣告」的識別字。
 *
 * 用法:npm run check:imports
 *
 * ---- 本掃描器自身的三個坑(修改之前務必先讀) ----
 *
 * 掃描器回報「乾淨」不等於真的乾淨 —— 損壞的掃描器同樣會回報乾淨。
 * 驗證方式是:複製一份 src、刻意移除某個 import、確認會被抓到。
 * 前兩個洞即是如此實測出來的:
 *
 * 1. 展開運算子:`{ ...DEFAULTS }` 的 DEFAULTS 前方是點,會被
 *    「排除 obj.prop」的規則誤判為屬性存取而整個略過 ——
 *    而崩潰 #3 的原始形態正好就是這一種。
 * 2. 括號:不可將任何 `(...)` 後接 `{` 都視為函式參數列,
 *    否則 `if (x) {` 的條件式內容會被當成參數而列入白名單,
 *    任何在 if 條件中出現過的名稱都會被消音。
 *
 * 3. 正規表達式字面值(2026-08-25 已修正,但仍是最脆弱的一環)。
 *    stripNoise 原本不認得 /…/ 這種字面值,因此其中的引號與反引號會被
 *    當成字串的開頭。sync-highlight.js 的標點正規表達式內含一個反引號,
 *    而該檔全檔僅此一個,配不到結尾,於是自該行起直到檔尾全部被抹成空白 ——
 *    該檔的 7 個 export 對掃描器完全隱形(跨模組 export 名稱數 102,
 *    修正後為 109),任何模組用到 alignLrc、activeIndexAt、paintSweep
 *    而忘記 import,本工具都不會回報。
 *
 *    現行作法是以 prevIsValue 分辨 `/` 是除號或字面值的開頭。這個判斷
 *    先天是啟發式的,改動 stripNoise 時務必重跑上述驗證法:
 *    移除 lrc-panel.js 對 sync-highlight 的 import,確認五處都被抓到;
 *    同時確認未改動的副本仍回報乾淨(沒有誤報),且 export 名稱數仍是 109
 *    —— 數字掉下來就代表又有某支模組被整片抹掉了。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = process.argv[2] ?? 'src';

/* --------------------------------------------------- 收集檔案 */

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/* ------------------------------------- 去除註解與字串(避免誤判) */

/**
 * 這些關鍵字後面的 `/` 一定是正規表達式的開頭,不可能是除號。
 * 其餘情況則看前一個 token 有沒有產生值(見 stripNoise 的 prevIsValue)。
 */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * 自 start 這個 `/` 起,找出正規表達式字面值的結尾 `/`。
 *
 * 字元類別 `[...]` 內的 `/` 不算結尾(`/[a-z/]/` 是合法的),故須分開追蹤。
 * 找不到結尾、或先遇到換行,即回傳 -1 —— 那代表它其實是除號,不可當字面值處理。
 *
 * @returns {number} 結尾 `/` 的位置;並非字面值時回傳 -1
 */
function scanRegexLiteral(src, start, n) {
  let inClass = false;
  for (let j = start + 1; j < n; j += 1) {
    const ch = src[j];
    if (ch === '\\') {
      j += 1; // 跳過被跳脫的那個字元
      continue;
    }
    if (ch === '\n') return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '/') return j;
  }
  return -1;
}

/**
 * 將註解、字串、樣板字串、正規表達式字面值的內容替換為空白。
 * 長度保持不變,行號才不會偏移。樣板字串的 ${} 內是真正的程式碼,須保留。
 *
 * 正規表達式一定要認得,否則其中的引號與反引號會被當成字串的開頭 ——
 * 那會使自該處起至檔尾整片被誤判為字串而抹去,掃描器對整支模組完全失明。
 * 這正是先前 sync-highlight.js 所發生的事,詳見檔頭第 3 個坑。
 */
function stripNoise(src) {
  const out = Array.from(src);
  let i = 0;
  const n = src.length;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  /*
   * 前一個有意義的 token 是否產生值。
   *
   * 這是分辨 `a / b`(除號)與 `/abc/`(字面值)唯一可靠的依據:
   * 除號之前必定是一個值(識別字、數字、`)`、`]`、字串),
   * 而字面值之前必定不是(`(`、`,`、`=`、`return` 等等)。
   */
  let prevIsValue = false;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // 行註解
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // 區塊註解
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    // 一般字串
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      prevIsValue = true;
      i = j + 1;
      continue;
    }
    // 樣板字串:內容清除,但 ${...} 內是程式碼須保留
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            k++;
          }
          j = k;
          continue;
        }
        out[j] = out[j] === '\n' ? '\n' : ' ';
        j++;
      }
      prevIsValue = true;
      i = j + 1;
      continue;
    }
    /*
     * 正規表達式字面值。此處的 `/` 已經確定不是註解(上面兩個分支先攔),
     * 所以只剩「除號」與「字面值」兩種可能,由 prevIsValue 分辨。
     * 兩側的 `/` 與旗標留著不動,只把內容抹掉 —— 那裡面沒有真正的識別字。
     */
    if (c === '/' && !prevIsValue) {
      const end = scanRegexLiteral(src, i, n);
      if (end > 0) {
        blank(i + 1, end);
        i = end + 1;
        while (i < n && /[a-z]/i.test(src[i])) i += 1; // 略過 g / i / m 這些旗標
        prevIsValue = true;
        continue;
      }
      // 找不到結尾就當它是除號,照一般字元往下走
    }
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) {
        // 整個識別字一起看:關鍵字後面的 `/` 是字面值,其餘(變數、數字)是除號
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j += 1;
        prevIsValue = !KEYWORDS_BEFORE_REGEX.has(src.slice(i, j));
        i = j;
        continue;
      }
      prevIsValue = c === ')' || c === ']';
    }
    i++;
  }
  return out.join('');
}

/* --------------------------------------------------- 解析 */

/** 本模組 export 了哪些名稱 */
function parseExports(code) {
  const names = new Set();
  for (const m of code.matchAll(
    /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  )) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}

/**
 * 僅是「轉手」出去、本地其實不存在的名稱。
 *
 *   export { x } from './y.js';   ← 供其他模組使用,但這支檔案裡沒有 x
 *   export { x };                 ← x 為本地定義,這支檔案裡有
 *
 * 兩者在 parseExports 眼中形態相同。分辨不出即會漏掉一整類錯誤:
 * 只寫了轉手那一行、自身卻也在使用那個名稱。該類錯誤打包不報、載入不報,
 * 須執行到那一行才拋出 ReferenceError。
 *
 * (這並非假設 —— corrections-store.js 即是如此把「按下儲存沒有反應」
 *  送上線的,而當時本掃描器回報乾淨。)
 */
function parseReExports(code) {
  const names = new Set();
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      // 有 as 時對外名稱為 as 之後那個,但本地同樣沒有這個名稱
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}

/** 本模組 import 進來哪些名稱 */
function parseImports(code) {
  const names = new Set();
  for (const m of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]/g)) {
    const clause = m[1];
    // 具名 { a, b as c }
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const as = piece.split(/\s+as\s+/);
        names.add((as[1] ?? as[0]).trim());
      }
    }
    // 預設 import 與 namespace import
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
    for (const tok of head.split(/\s+/)) {
      if (!tok || tok === '*' || tok === 'as') continue;
      if (/^[A-Za-z_$][\w$]*$/.test(tok)) names.add(tok);
    }
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.add(ns[1]);
  }
  return names;
}

/**
 * 本模組自身宣告了哪些名稱。
 * 不做完整 scope 分析 —— 只要檔案中任何位置宣告過即計入。寧可漏報也不誤報。
 */
function parseLocalDeclarations(code) {
  const names = new Set();
  const patterns = [
    /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    // 解構宣告:const { a, b } = … / const [a, b] = …
    /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      for (const part of m[1].split(',')) {
        const piece = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
      }
    }
  }

  /*
   * 函式參數視為本地名稱。
   *
   * 此處不可寫成「任何 (…) 後方接 {」—— 那會把 if (x) { / for (…) { /
   * while (…) { 的條件式內容也當成參數,於是任何在 if 條件中出現過的名稱
   * 都被列入白名單而消音,真正的漏 import 便遭遮蔽(見檔頭第 2 個坑)。
   * 故僅認可真正屬於參數列的形態。
   */
  const NOT_A_FUNCTION = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'do', 'with',
  ]);
  const paramPatterns = [
    /\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g, // function name(…) / function(…)
    /\(([^()]*)\)\s*=>/g,                                        // (…) =>
  ];
  for (const re of paramPatterns) {
    for (const m of code.matchAll(re)) {
      for (const part of m[1].split(',')) {
        const piece = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
      }
    }
  }
  // 物件或類別的方法簡寫 name(…) { —— 排除 if/for/while 這些關鍵字
  for (const m of code.matchAll(/(?:^|[\s,;{}])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
    if (NOT_A_FUNCTION.has(m[1])) continue;
    for (const part of m[2].split(',')) {
      const piece = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
    }
  }
  // 單參數箭頭函式 x => …
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * 將 import 與 export-from 陳述式替換為空白(保留換行,行號不偏移)。
 *
 * 必須執行:`import { CORRECTIONS as BUILTIN }` 中的原名 CORRECTIONS
 * 會被視為「用到了但沒有 import」—— 別名 import 將全數誤報。
 */
function blankImportStatements(code) {
  return code.replace(
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"][^'"]*['"]\s*;?|(?:^|\n)\s*import\s*['"][^'"]*['"]\s*;?/g,
    (m) => m.replace(/[^\n]/g, ' ')
  );
}

/** 檔案中用到的識別字(排除 obj.prop 的 prop 與 {key: 的 key) */
function parseUsedIdentifiers(code) {
  const used = new Map(); // name -> 第一次出現的行號
  /*
   * 展開運算子的三個點須先移除。
   * 判定「並非 obj.prop」是看前一個字元不是 `.`,但 `{ ...DEFAULTS }` 的
   * DEFAULTS 前方恰好也是 `.`,會被當成屬性存取而整個略過 ——
   * 崩潰 #3(漏 import DEFAULTS)的原始形態正是這一種(見檔頭第 1 個坑)。
   */
  code = code.replace(/\.\.\./g, '   ');
  code.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      // 物件字面值的 key(name:)不算使用
      const after = line.slice(m.index + m[0].length);
      if (/^\s*:/.test(after)) continue;
      if (!used.has(name)) used.set(name, idx + 1);
    }
  });
  return used;
}

/* --------------------------------------------------- 主流程 */

const files = walk(SRC);
const parsed = new Map();

for (const file of files) {
  const code = stripNoise(readFileSync(file, 'utf8'));
  parsed.set(file, {
    exports: parseExports(code),
    reExports: parseReExports(code),
    imports: parseImports(code),
    locals: parseLocalDeclarations(code),
    used: parseUsedIdentifiers(blankImportStatements(code)),
  });
}

// 全專案的 export 名稱 → 來自哪支檔案
const exportOwners = new Map();
for (const [file, info] of parsed) {
  for (const name of info.exports) {
    if (!exportOwners.has(name)) exportOwners.set(name, []);
    exportOwners.get(name).push(file);
  }
}

let problems = 0;

for (const [file, info] of parsed) {
  const findings = [];
  for (const [name, line] of info.used) {
    if (!exportOwners.has(name)) continue;  // 不是任何模組的 export
    // 「自身即為 export 者」須排除純轉手的:export { x } from 不會建立本地的 x
    if (info.exports.has(name) && !info.reExports.has(name)) continue;
    if (info.imports.has(name)) continue;   // 已正確 import
    if (info.locals.has(name)) continue;    // 本地有宣告(同名但無關)
    const owners = exportOwners.get(name).filter((f) => f !== file);
    if (!owners.length) continue;
    findings.push({ name, line, owners });
  }
  if (findings.length) {
    problems += findings.length;
    console.log(`\n✗ ${relative(process.cwd(), file)}`);
    for (const f of findings) {
      const from = f.owners.map((o) => relative(process.cwd(), o)).join(', ');
      console.log(`    第 ${f.line} 行:用到 \`${f.name}\` 但沒有 import(定義在 ${from})`);
    }
  }
}

console.log(`\n掃描 ${files.length} 支模組,${exportOwners.size} 個跨模組 export 名稱。`);
if (problems === 0) {
  console.log('✓ 沒有發現漏 import');
} else {
  console.log(`✗ 發現 ${problems} 處疑似漏 import`);
  process.exitCode = 1;
}
