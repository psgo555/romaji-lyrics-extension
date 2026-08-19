/**
 * build.mjs
 * 用 esbuild 把 wanakana / kuroshiro / kuromoji 打包進擴充功能。
 *
 * 為什麼一定要打包(README 限制 #1):
 * 頁面 CSP 會擋掉從 CDN 動態載入的 script,擴充功能必須自帶所有程式碼。
 *
 * 產出 dist/ 就是「載入未封裝項目」要選的資料夾。
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/*
 * 送給 LRCLIB 的來源識別碼,從 package.json 取得,不在程式裡另外寫死一份。
 *
 * 為什麼要這樣繞:LRCLIB 要求標明來源,是為了出問題時能聯絡開發者。
 * 先前那裡填的是 github.com/local/... 這種不存在的網址,等於規避了這個要求。
 * 改成從 package.json 讀,版本號也自動跟著走,不會出現「程式裡寫 0.1.0、
 * 實際已經是 0.3.0」這種對不上的情況。
 */
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const repoUrl = pkg.repository?.url ?? '';
const clientHeader = `${pkg.name}/${pkg.version} (${repoUrl})`;

/** 還沒把 GitHub 帳號填進去就大聲擋下來,免得帶著佔位網址發布出去 */
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
 * kuromoji 的 package.json 有 browser 欄位,esbuild 的 platform:'browser'
 * 會自動把 NodeDictionaryLoader 換成 BrowserDictionaryLoader(用 XMLHttpRequest 讀 .dat.gz)。
 * 萬一還有沒被換掉的 node 專用 require 漏進來,這個 plugin 會把 fs 解析成空模組,
 * 讓打包不至於整個失敗。
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
    // 來源識別碼在打包時注入,程式裡不寫死(見上方 clientHeader 的說明)
    __LRCLIB_CLIENT__: JSON.stringify(clientHeader),
  },
  alias: { path: 'path-browserify' },
  plugins: [stubNodeBuiltins],
  // kuroshiro-analyzer-kuromoji 只有在沒收到 dictPath 時才會走 require.resolve("kuromoji")
  // 去猜辭典位置。我們一律明確傳入 chrome.runtime.getURL('dict/'),那段是死碼。
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
 * 第三方套件的授權聲明,一定要跟著進擴充功能。
 *
 * ── 這不是禮貌問題,是授權條款的明文要求 ──────────────────────
 * kuromoji 是 Apache-2.0,規定散布時要附上 NOTICE。
 * 而它裡面那份辭典(mecab-ipadic)的條款講得更死:
 *   「任何複製品,不論原樣或修改過,都必須包含上述版權聲明與以下段落」
 *   而且免責聲明那段寫明 ALWAYS 要附上。
 * MIT(kuroshiro、wanakana)同樣要求保留版權聲明。
 *
 * 自己載來用不受影響,一旦公開散布就必須附。
 *
 * 刻意從 node_modules 實際讀取而不是手抄一份:手抄的不會跟著套件升級走,
 * 哪天換了版本、條款改了也不會有人發現。
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
        // 硬性失敗 —— 少附一份授權就是違反條款,不可以安靜略過
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

/** kuromoji 的辭典檔要跟著進擴充功能,由 manifest 的 web_accessible_resources 開放讀取 */
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
 * 圖示。
 *
 * 圖案是「上面一條長的、下面一條短的」—— 對應這個擴充功能實際在做的事:
 * 原文在上,拼音在下。刻意只用兩條線條而不畫假名或字母:
 * 16 像素下任何筆畫複雜的東西都會糊成一團,而長短對比在那個尺寸還看得出來。
 *
 * 先前這裡是一整塊純綠色(檔案只有 79 bytes),註解自己寫著「佔位」。
 * 自己載來用無所謂,公開發布時使用者在工具列上根本認不出那是什麼。
 */

/** 圓角矩形的距離場:回傳負值代表在裡面。用它才能算出邊緣的覆蓋率做去鋸齒。 */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * 畫出圖示的 PNG。
 *
 * 用 4×4 超取樣做去鋸齒 —— 直接判斷「在裡面/在外面」的話,圓角跟線條的
 * 邊緣會有明顯的階梯,在 128 像素那張特別醜。
 */
function iconPng(size) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([head.subarray(0, 4), body, tail]);
  };

  const GREEN = [0x1d, 0xb9, 0x54]; // 跟 popup 的重點色一致
  const SS = 4; // 每邊取樣次數

  // 全部用 0~1 的比例定義,三種尺寸共用同一份設計
  const shapes = {
    background: { cx: 0.5, cy: 0.5, hw: 0.5, hh: 0.5, r: 0.22 },
    original: { cx: 0.5, cy: 0.38, hw: 0.28, hh: 0.055, r: 0.055 }, // 原文:長
    romaji: { cx: 0.4, cy: 0.62, hw: 0.18, hh: 0.04, r: 0.04 }, // 拼音:短一點、細一點
  };

  const inside = (s, x, y) =>
    roundedRectDistance(x, y, s.cx, s.cy, s.hw, s.hh, s.r) <= 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type: None

    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let barHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inside(shapes.background, u, v)) continue;
          bgHits += 1;
          if (inside(shapes.original, u, v) || inside(shapes.romaji, u, v)) barHits += 1;
        }
      }

      const total = SS * SS;
      const p = rowStart + 1 + x * 4;

      if (bgHits === 0) {
        raw.writeUInt32BE(0, p); // 圓角外面完全透明
        continue;
      }

      // 線條是白的,底是綠的,依覆蓋率混色
      const barRatio = barHits / bgHits;
      for (let i = 0; i < 3; i += 1) {
        raw[p + i] = Math.round(GREEN[i] * (1 - barRatio) + 0xff * barRatio);
      }
      raw[p + 3] = Math.round((bgHits / total) * 255); // 邊緣的透明度
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour + alpha(圓角要透明)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeIcons() {
  const dir = path.join(dist, 'icons');
  await mkdir(dir, { recursive: true });
  for (const size of [16, 48, 128]) {
    await writeFile(path.join(dir, `icon${size}.png`), iconPng(size));
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  assertRepoConfigured();

  await copyDictionary();
  await copyLicenses();
  await copyStatic();
  await writeIcons();

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
