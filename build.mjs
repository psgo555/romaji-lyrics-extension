/**
 * build.mjs
 * 以 esbuild 將 wanakana / kuroshiro / kuromoji 打包進擴充功能。
 *
 * 必須打包的原因(README 限制 #1):
 * 頁面 CSP 會阻擋自 CDN 動態載入的 script,擴充功能必須自帶全部程式碼。
 *
 * 產出的 dist/ 即為「載入未封裝項目」所要選擇的資料夾。
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/*
 * 送交 LRCLIB 的來源識別碼,自 package.json 取得,不在程式中另寫一份。
 *
 * 如此迂迴的原因:LRCLIB 要求標明來源,是為了出問題時能聯絡開發者。
 * 先前該處填的是 github.com/local/... 這類不存在的網址,形同規避該項要求。
 * 改為自 package.json 讀取後版本號亦自動跟進,不致出現「程式中寫 0.1.0、
 * 實際已是 0.3.0」的落差。
 */
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const repoUrl = pkg.repository?.url ?? '';
const clientHeader = `${pkg.name}/${pkg.version} (${repoUrl})`;

/** 尚未填入 GitHub 帳號時明確警示,避免帶著佔位網址發布出去 */
function assertRepoConfigured() {
  if (!repoUrl.includes('YOUR-USERNAME')) return;
  console.error('\n' + '='.repeat(70));
  console.error('⚠  package.json 的 repository 還是佔位網址,發布前一定要改!');
  console.error('');
  console.error('   目前:', repoUrl);
  console.error('   請把 YOUR-USERNAME 換成你的 GitHub 帳號。');
  console.error('');
  console.error('   這個網址會送給 LRCLIB 當來源識別 —— 填假的等於規避他們');
  console.error('   「出問題要找得到人」的要求,量大了可能被擋。');
  console.error('   自己測試沒關係,公開發布前務必修正。');
  console.error('='.repeat(70) + '\n');
}

/**
 * kuromoji 的 package.json 含 browser 欄位,esbuild 的 platform:'browser'
 * 會自動將 NodeDictionaryLoader 換成 BrowserDictionaryLoader(以 XMLHttpRequest 讀取 .dat.gz)。
 * 萬一仍有未被替換的 node 專用 require 漏入,本 plugin 會將 fs 解析為空模組,
 * 使打包不致整個失敗。
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^fs$|^node:fs$/ }, () => ({
      path: 'stub-fs',
      namespace: 'stub',
    }));
    pluginBuild.onLoad({ filter: /^stub-fs$/, namespace: 'stub' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

const bundleOptions = {
  entryPoints: {
    'content': path.join(root, 'src/content/index.js'),
    'service-worker': path.join(root, 'src/background/service-worker.js'),
    'popup/popup': path.join(root, 'src/popup/popup.js'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    global: 'globalThis',
    // 來源識別碼於打包時注入,程式中不寫死(見上方 clientHeader 的說明)
    __LRCLIB_CLIENT__: JSON.stringify(clientHeader),
    // 分享讀音時要開啟的 issue 頁面,同樣不在程式中寫死
    __REPO_URL__: JSON.stringify(repoUrl),
  },
  alias: { path: 'path-browserify' },
  plugins: [stubNodeBuiltins],
  // kuroshiro-analyzer-kuromoji 僅在未收到 dictPath 時才會透過 require.resolve("kuromoji")
  // 推測辭典位置。此處一律明確傳入 chrome.runtime.getURL('dict/'),那一段是死碼。
  logOverride: { 'require-resolve-not-external': 'silent' },
};

/* -------------------------------------------------------------- 靜態檔 */

async function copyStatic() {
  await cp(path.join(root, 'public/manifest.json'), path.join(dist, 'manifest.json'));
  await cp(path.join(root, 'src/content/overlay.css'), path.join(dist, 'overlay.css'));
  await mkdir(path.join(dist, 'popup'), { recursive: true });
  for (const file of ['popup.html', 'popup.css']) {
    await cp(path.join(root, 'src/popup', file), path.join(dist, 'popup', file));
  }
}

/*
 * 第三方套件的授權聲明必須一併納入擴充功能。
 *
 * ── 這並非禮貌問題,而是授權條款的明文要求 ────────────────────
 * kuromoji 為 Apache-2.0,規定散布時須附上 NOTICE。
 * 而其中隨附的辭典(mecab-ipadic)條款更為明確:
 *   「任何複製品,不論原樣或經修改,皆必須包含上述版權聲明與以下段落」
 *   且免責聲明該段寫明 ALWAYS 須附上。
 * MIT(kuroshiro、wanakana)同樣要求保留版權聲明。
 *
 * 自行下載使用不受影響,一旦公開散布即必須附上。
 *
 * 刻意自 node_modules 實際讀取而非手抄一份:手抄的內容不會隨套件升級更新,
 * 日後換了版本、條款有所變動亦不會有人察覺。
 */
const LICENSED_PACKAGES = [
  { name: 'kuroshiro', files: ['LICENSE'] },
  { name: 'kuroshiro-analyzer-kuromoji', files: ['LICENSE'] },
  { name: 'kuromoji', files: ['LICENSE-2.0.txt', 'NOTICE.md'] },
  { name: 'wanakana', files: ['LICENSE'] },
];

async function copyLicenses() {
  const parts = [
    '本擴充功能使用了以下開放原始碼軟體,以下是它們的授權聲明。',
    '',
    '其中 kuromoji 隨附的日文辭典(mecab-ipadic)版權屬於',
    '奈良先端科學技術大學院大學,其條款要求任何散布都必須附上完整聲明。',
    '',
    '='.repeat(78),
    '',
  ];

  for (const pkg of LICENSED_PACKAGES) {
    for (const file of pkg.files) {
      const source = path.join(root, 'node_modules', pkg.name, file);
      if (!existsSync(source)) {
        // 硬性失敗 —— 少附一份授權即違反條款,不可無聲略過
        throw new Error(`找不到 ${pkg.name}/${file},無法產生授權聲明。請先執行 npm install`);
      }
      parts.push(
        `【${pkg.name} — ${file}】`,
        '',
        await readFile(source, 'utf8'),
        '',
        '-'.repeat(78),
        ''
      );
    }
  }

  await writeFile(path.join(dist, 'THIRD-PARTY-NOTICES.txt'), parts.join('\n'), 'utf8');
  console.log(`  已產生 THIRD-PARTY-NOTICES.txt(${LICENSED_PACKAGES.length} 個套件)`);
}

/** kuromoji 的辭典檔須一併納入擴充功能,由 manifest 的 web_accessible_resources 開放讀取 */
async function copyDictionary() {
  const src = path.join(root, 'node_modules/kuromoji/dict');
  if (!existsSync(src)) {
    throw new Error('找不到 node_modules/kuromoji/dict,請先執行 npm install');
  }
  await cp(src, path.join(dist, 'dict'), { recursive: true });
  const files = await readdir(path.join(dist, 'dict'));
  console.log(`  已複製 ${files.length} 個辭典檔到 dist/dict/`);
}

/* ---------------------------------------------------------------- 圖示 */

/*
 * 圖示為預先產生,置於 public/icons/,此處僅負責複製。
 *
 * 不在此即時產生的原因:圖示的來源是一張 1254x1254 的 PNG,
 * 須去背、裁切、重新取樣才能成為 16/48/128。那些程式並不短,
 * 而圖示幾乎不會變動 —— 每次 build 都執行一遍只是浪費時間,亦使本檔難讀。
 *
 * 更換圖示的流程:替換 public/icon-source.png → npm run icons → 產出進版控。
 */
async function copyIcons() {
  const src = path.join(root, 'public/icons');
  if (!existsSync(src)) {
    throw new Error('找不到 public/icons/,請先執行 npm run icons');
  }
  await cp(src, path.join(dist, 'icons'), { recursive: true });
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  assertRepoConfigured();

  await copyDictionary();
  await copyLicenses();
  await copyStatic();
  await copyIcons();

  if (watch) {
    const ctx = await context(bundleOptions);
    await ctx.watch();
    console.log('watch 模式啟動,修改 src/ 會自動重新打包(靜態檔需重跑 npm run build)');
    return;
  }

  await build(bundleOptions);
  console.log('\n打包完成 → dist/');
  console.log('到 chrome://extensions 開啟開發人員模式,「載入未封裝項目」選擇 dist 資料夾。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
