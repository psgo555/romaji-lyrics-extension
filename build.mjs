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
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

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
  define: { global: 'globalThis' },
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

/** 產生單色 PNG,免得為了三個佔位圖示還要連網下載素材 */
function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([head.subarray(0, 4), body, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolour

  // 每一列前面要有一個 filter type byte(0 = None)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

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
    await writeFile(path.join(dir, `icon${size}.png`), solidPng(size, [0x1d, 0xb9, 0x54]));
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  await copyDictionary();
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
