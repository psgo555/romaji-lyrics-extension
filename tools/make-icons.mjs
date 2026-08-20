/**
 * make-icons.mjs
 * 把一張大圖轉成擴充功能要的三種尺寸圖示。
 *
 * 用法:npm run icons
 *   讀  public/icon-source.png
 *   產  public/icons/icon{16,48,128}.png
 *
 * ── 為什麼不放進 build.mjs 每次跑 ────────────────────────────
 * 圖示幾乎不會變,而這支要自己解 PNG、去背、重新取樣,程式量不小。
 * 讓每次 build 都跑一遍只是浪費時間,也會讓 build.mjs 難讀。
 * 換圖的時候手動跑一次,產出的檔案進版控。
 *
 * ── 三個步驟,每一個都是為了解決一個實際問題 ──────────────────
 * 1. 去背:來源圖的圓角外面是**不透明的白色**。直接用的話,
 *    在深色工具列上會看到一個白方塊框住圖示。
 *    做法是從四個角往內漫延,把連通到外緣的白色變透明 ——
 *    圖案內部的白色筆畫(あ、R)被綠色包住,漫延到不了,不會被誤傷。
 * 2. 裁切:來源圖四周有留白,不裁的話縮小後圖案會顯得很小。
 * 3. 縮圖:用區域平均而不是最近鄰 —— 1254 縮到 16 是七十幾倍,
 *    最近鄰等於每 78 個像素只取一個,細筆畫會整條消失或變鋸齒。
 *
 * 專案沒有裝任何影像處理套件(那會為了一次性的工作多帶一個相依),
 * 所以 PNG 的解碼與編碼是自己寫的。只支援這張圖用到的格式:
 * 8 位元、非交錯、色彩型別 2 或 6 —— 遇到別的會明白地失敗,不會靜默出錯。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(root, 'public/icon-source.png');
const OUT_DIR = path.join(root, 'public/icons');
const SIZES = [16, 48, 128];

/** 判定為「背景白」的門檻。來源圖的白底不一定是純白(有壓縮雜訊) */
const WHITE_THRESHOLD = 236;

/* ------------------------------------------------------------ 解碼 */

/** 解 PNG 成 RGBA 像素陣列 */
function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('不是 PNG 檔');
  }

  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`只支援 8 位元色深,這張是 ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`只支援色彩型別 2 或 6,這張是 ${colorType}`);
      }
      if (data[12] !== 0) throw new Error('不支援交錯式 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length; // 長度(4) + 型別(4) + 資料 + CRC(4)
  }

  const channels = colorType === 6 ? 4 : 3;
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);

  if (channels === 4) return { width, height, pixels };

  // 統一成 RGBA,後面的處理就不必分兩種
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = pixels[i * 3];
    rgba[i * 4 + 1] = pixels[i * 3 + 1];
    rgba[i * 4 + 2] = pixels[i * 3 + 2];
  }
  return { width, height, pixels: rgba };
}

/**
 * 還原掃描線的濾波器。
 * PNG 每一列前面有一個位元組指定用了哪種濾波,要逐列反推回原始像素值。
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels] : 0; // 左
      const b = y > 0 ? out[(y - 1) * stride + x] : 0; // 上
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0; // 左上

      let value = line[x];
      switch (filterType) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: value += paeth(a, b, c); break;
        default: throw new Error(`認不得的濾波器型別 ${filterType}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/* ------------------------------------------------------ 去背與裁切 */

/**
 * 從四個角漫延,把連通到畫布外緣的白色變透明。
 *
 * 關鍵是「連通」:圖案內部的白色筆畫(あ 和 R)被綠色底包住,
 * 漫延到不了那裡,所以不會被誤傷。單純「把所有白色變透明」
 * 會把那兩個字整個挖掉。
 */
function removeOuterWhite({ width, height, pixels }) {
  const visited = new Uint8Array(width * height);
  const stack = [];

  const isWhite = (i) =>
    pixels[i * 4] >= WHITE_THRESHOLD &&
    pixels[i * 4 + 1] >= WHITE_THRESHOLD &&
    pixels[i * 4 + 2] >= WHITE_THRESHOLD;

  // 四條邊上的像素都是起點
  for (let x = 0; x < width; x += 1) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 1) stack.push(y * width, y * width + width - 1);

  while (stack.length) {
    const i = stack.pop();
    if (visited[i] || !isWhite(i)) continue;
    visited[i] = 1;
    pixels[i * 4 + 3] = 0; // 變透明

    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - width);
    if (y < height - 1) stack.push(i + width);
  }
}

/** 裁掉四周全透明的部分,讓圖案填滿畫布 */
function cropToContent({ width, height, pixels }) {
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  if (right < 0) throw new Error('去背之後整張圖都是透明的,檢查 WHITE_THRESHOLD');

  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    pixels.copy(out, y * w * 4, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4);
  }
  return { width: w, height: h, pixels: out };
}

/**
 * 補成正方形(置中,四周留透明)。
 *
 * 為什麼需要:裁切的範圍會把圖案的**陰影**也算進去,而陰影通常只在
 * 下方或單邊,裁出來就不是正方形了(實測 966x990)。
 * 直接縮成 16x16 等於橫向壓扁 2.4% —— 圓角會變成橢圓、字會變形。
 *
 * 補透明而不是拉伸,圖案的比例就完全不變。
 */
function padToSquare({ width, height, pixels }) {
  if (width === height) return { width, height, pixels };

  const size = Math.max(width, height);
  const out = Buffer.alloc(size * size * 4); // 預設全 0 = 全透明
  const offsetX = Math.floor((size - width) / 2);
  const offsetY = Math.floor((size - height) / 2);

  for (let y = 0; y < height; y += 1) {
    pixels.copy(out, ((y + offsetY) * size + offsetX) * 4, y * width * 4, (y + 1) * width * 4);
  }
  return { width: size, height: size, pixels: out };
}

/* ---------------------------------------------------------- 縮圖 */

/**
 * 區域平均縮圖:每個目標像素取來源對應矩形的平均值。
 *
 * 顏色要**用 alpha 加權**再平均 —— 透明處的顏色是沒有意義的,
 * 直接平均會把邊緣拉向那些無意義的值,看起來像一圈髒邊。
 */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = src.width / size;
  const scaleY = src.height / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      const y0 = Math.floor(y * scaleY);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < src.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < src.width; sx += 1) {
          const i = (sy * src.width + sx) * 4;
          const alpha = src.pixels[i + 3] / 255;
          r += src.pixels[i] * alpha;
          g += src.pixels[i + 1] * alpha;
          b += src.pixels[i + 2] * alpha;
          a += src.pixels[i + 3];
          count += 1;
        }
      }

      // 除以 alpha 的總和而不是像素數,半透明邊緣的顏色才不會被沖淡
      const alphaSum = a / 255;
      const o = (y * size + x) * 4;
      out[o] = alphaSum ? Math.round(r / alphaSum) : 0;
      out[o + 1] = alphaSum ? Math.round(g / alphaSum) : 0;
      out[o + 2] = alphaSum ? Math.round(b / alphaSum) : 0;
      out[o + 3] = Math.round(a / count);
    }
  }

  return { width: size, height: size, pixels: out };
}

/* ---------------------------------------------------------- 編碼 */

function encodePng({ width, height, pixels }) {
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位元深度
  ihdr[9] = 6; // RGBA

  // 每一列前面補一個濾波器位元組(0 = 不濾波)
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------- 主流程 */

const source = decodePng(readFileSync(SOURCE));
console.log(`來源:${source.width}x${source.height}`);

removeOuterWhite(source);
const cropped = padToSquare(cropToContent(source));
console.log(`去背、裁切、補成正方形後:${cropped.width}x${cropped.height}`);

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(path.join(OUT_DIR, `icon${size}.png`), encodePng(resize(cropped, size)));
  console.log(`  產出 icon${size}.png`);
}
