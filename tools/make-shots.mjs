#!/usr/bin/env node
/**
 * make-shots.mjs
 * 把隨手截的圖,做成 Chrome 線上應用程式商店要的規格。
 *
 *   node tools/make-shots.mjs <檔案或資料夾> [--crop-right 470] [--crop-top 0] ...
 *
 * 商店的要求:1280×800(或 640×400)、PNG 不含透明色版、最多 5 張。
 * 這支負責尺寸與去掉透明;**裁切要人自己決定** —— 哪一塊是重點,程式看不出來。
 *
 * ── 為什麼要有這支 ────────────────────────────────────────────
 * 截圖工具框出來的大小是隨機的,直接上傳會被退件或被自動裁掉重點。
 * 手動用小畫家調又很容易把字弄糊(縮放演算法差),或存成含透明的 PNG 而被拒。
 * 這兩件事不值得每次上架前重做一遍。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { crop, decodePng, edgeColor, encodePng, fitInto } from './png.mjs';

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 800;

function parseArgs(argv) {
  const input = argv.find((a) => !a.startsWith('--'));
  const number = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? Number(argv[at + 1]) || 0 : 0;
  };
  return {
    input,
    box: {
      left: number('crop-left'),
      top: number('crop-top'),
      right: number('crop-right'),
      bottom: number('crop-bottom'),
    },
  };
}

function listPngs(target) {
  if (statSync(target).isDirectory()) {
    return readdirSync(target)
      .filter((name) => extname(name).toLowerCase() === '.png')
      .map((name) => join(target, name));
  }
  return [target];
}

function main() {
  const { input, box } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error('用法:node tools/make-shots.mjs <檔案或資料夾> [--crop-right 470]');
    process.exit(1);
  }

  const files = listPngs(input);
  if (!files.length) {
    console.error(`${input} 裡沒有 .png`);
    process.exit(1);
  }

  // 輸出放在來源旁邊的 out/,不要蓋掉原檔 —— 裁切的數字常常要試好幾次
  const outDir = join(statSync(input).isDirectory() ? input : dirname(input), 'out');
  mkdirSync(outDir, { recursive: true });

  const hasCrop = box.left || box.top || box.right || box.bottom;

  for (const file of files) {
    const source = decodePng(readFileSync(file));
    const cropped = hasCrop ? crop(source, box) : source;
    const result = fitInto(cropped, TARGET_WIDTH, TARGET_HEIGHT, edgeColor(cropped));

    writeFileSync(join(outDir, basename(file)), encodePng(result)); // 不含透明

    const padded = result.inner.width < TARGET_WIDTH || result.inner.height < TARGET_HEIGHT;
    console.log(
      `${basename(file)}  ${source.width}×${source.height}` +
        (hasCrop ? ` → 裁成 ${cropped.width}×${cropped.height}` : '') +
        ` → ${TARGET_WIDTH}×${TARGET_HEIGHT}` +
        `(內容縮到 ${Math.round(result.scale * 100)}%${padded ? ',四周補底色' : ''})`
    );
  }

  console.log(`\n完成 → ${outDir}`);
}

main();
