/**
 * check-imports.mjs
 * 漏 import 靜態掃描。
 *
 * 為什麼需要這一支:
 * esbuild 對「未定義的全域識別字」不報錯,build 階段攔不到;
 * 而「用 vm 執行 dist/content.js」的煙霧測試只跑到模組載入,抓不到
 * 只在某條分支才會呼叫到的漏 import(例如只有擴充功能被重新載入時
 * 才執行的 shutdown())。這個專案已經因為漏 import 崩潰過三次。
 *
 * 作法:先收集所有模組 export 了什麼,再對每支模組找出
 * 「用到了別的模組的 export 名稱、但自己既沒 import 也沒在本地宣告」的識別字。
 *
 * 用法:npm run check:imports
 *
 * ---- 這支掃描器自己的兩個坑(改它之前務必先看) ----
 *
 * 掃描器回報「乾淨」不等於真的乾淨 —— 壞掉的掃描器也會回報乾淨。
 * 驗證方式是:複製一份 src、故意把某個 import 拿掉、確認會被抓到。
 * 實測時就是這樣抓到下面兩個洞的:
 *
 * 1. 展開運算子:`{ ...DEFAULTS }` 的 DEFAULTS 前面是點,會被
 *    「排除 obj.prop」的規則誤判成屬性存取而整個跳過 ——
 *    而崩潰 #3 的原始形態正好就是這一種。
 * 2. 括號:不能把任何 `(...)` 後接 `{` 都當成函式參數列,
 *    否則 `if (x) {` 的條件式內容會被當成參數而列入白名單,
 *    任何在 if 條件裡出現過的名字都會被消音。
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

/* ------------------------------------- 去掉註解與字串(避免誤判) */

/**
 * 把註解、字串、樣板字串的內容換成空白。
 * 長度保持不變,行號才不會跑掉。樣板字串的 ${} 內是真的程式碼,要保留。
 */
function stripNoise(src) {
  const out = Array.from(src);
  let i = 0;
  const n = src.length;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

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
      i = j + 1;
      continue;
    }
    // 樣板字串:內容清掉,但 ${...} 裡是程式碼要留著
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
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/* --------------------------------------------------- 解析 */

/** 這支模組 export 了哪些名字 */
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

/** 這支模組 import 進來哪些名字 */
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
    // 預設 import / namespace import
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
 * 這支模組自己宣告了哪些名字。
 * 不做完整 scope 分析 —— 只要檔案裡任何地方宣告過就算數。寧可漏報也不要誤報。
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
   * 函式參數視為本地名字。
   *
   * 這裡不能寫成「任何 (…) 後面接 {」—— 那會把 if (x) { / for (…) { /
   * while (…) { 的條件式內容也當成參數,於是任何在 if 條件裡出現過的名字
   * 都被列入白名單而消音,真正的漏 import 就被遮蔽了(見檔頭第 2 個坑)。
   * 所以只認真正是參數列的形態。
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
  // 物件/類別的方法簡寫 name(…) { —— 排開 if/for/while 這些關鍵字
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
 * 把 import / export-from 陳述式換成空白(保留換行,行號不跑掉)。
 *
 * 一定要做:`import { CORRECTIONS as BUILTIN }` 裡的原名 CORRECTIONS
 * 會被當成「用到了但沒 import」—— 別名 import 全都會誤報。
 */
function blankImportStatements(code) {
  return code.replace(
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"][^'"]*['"]\s*;?|(?:^|\n)\s*import\s*['"][^'"]*['"]\s*;?/g,
    (m) => m.replace(/[^\n]/g, ' ')
  );
}

/** 檔案裡用到的識別字(排除 obj.prop 的 prop 與 {key: 的 key) */
function parseUsedIdentifiers(code) {
  const used = new Map(); // name -> 第一次出現的行號
  /*
   * 展開運算子的三個點要先拿掉。
   * 判定「不是 obj.prop」是看前一個字元不是 `.`,但 `{ ...DEFAULTS }` 的
   * DEFAULTS 前面剛好也是 `.`,會被當成屬性存取整個跳過 ——
   * 崩潰 #3(漏 import DEFAULTS)的原始形態就正好是這一種(見檔頭第 1 個坑)。
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
    if (info.exports.has(name)) continue;   // 自己就是 export 者
    if (info.imports.has(name)) continue;   // 有好好 import
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
