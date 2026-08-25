/**
 * png.mjs
 * 最小的 PNG 讀寫實作,不依賴任何套件。
 *
 * ── 不安裝影像套件的原因 ──────────────────────────────────────
 * 本專案的 dependencies 會被打包進擴充功能,而使用者必須能相信
 * 「這個東西沒有偷做什麼」。多裝一個套件,對閱讀原始碼的人而言就是多一項要查的東西,
 * 而此處僅需要 PNG 的一小部分功能。
 *
 * 支援範圍刻意很窄:8 bit、非交錯。截圖工具與瀏覽器存出的皆為此種格式。
 * 遇到其他格式即明確報錯 —— 不可無聲輸出一張色彩損壞的圖。
 *
 * 註:tools/make-icons.mjs 內另有一份更早、僅處理方形的複本。該工具屬一次性
 * (圖示已產生完畢),且其一經 import 便會重新產生圖示,故無法直接沿用。
 * 下次確實要修改它時,再改為引用此處的實作。
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 還原每一列的濾波。
 * PNG 每一列可選擇一種「與左方或上方的差值」來儲存,未還原即直接讀取會使顏色整片糊掉。
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0; // 左
      const b = prev ? prev[i] : 0; // 上
      const c = prev && i >= channels ? prev[i - channels] : 0; // 左上
      let value = line[i];

      if (type === 1) value += a;
      else if (type === 2) value += b;
      else if (type === 3) value += (a + b) >> 1;
      else if (type === 4) value += paeth(a, b, c);
      else if (type !== 0) throw new Error(`認不得的 PNG 濾波方式:${type}`);

      cur[i] = value & 0xff;
    }
  }

  return out;
}

/**
 * @param {Buffer} buffer PNG 檔案內容
 * @returns {{width: number, height: number, pixels: Buffer}} pixels 一律為 RGBA
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('這不是 PNG 檔');

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // 長度 + 類型 + 內容 + CRC

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8) throw new Error(`只支援 8 bit 的 PNG(這張是 ${bitDepth})`);
      if (data[12] !== 0) throw new Error('不支援交錯式(interlaced)PNG');

      // 0=灰階 2=RGB 4=灰階+透明 6=RGBA。3(調色盤)未支援,截圖不會是那種。
      const map = { 0: 1, 2: 3, 4: 2, 6: 4 };
      channels = map[colorType];
      if (!channels) throw new Error(`不支援的 PNG 色彩格式:${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const flat = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);

  // 一律轉為 RGBA,後續即只需面對一種格式
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    const gray = channels <= 2;
    pixels[d] = flat[s];
    pixels[d + 1] = gray ? flat[s] : flat[s + 1];
    pixels[d + 2] = gray ? flat[s] : flat[s + 2];
    pixels[d + 3] = channels === 4 ? flat[s + 3] : channels === 2 ? flat[s + 1] : 255;
  }

  return { width, height, pixels };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {{width: number, height: number, pixels: Buffer}} image pixels 為 RGBA
 * @param {{alpha?: boolean}} [options] 預設不含透明 —— Chrome 線上應用程式商店的
 *   截圖不接受含透明色版的 PNG,故預設即存成 24 bit。
 */
export function encodePng({ width, height, pixels }, { alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 不做濾波,保持單純
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = pixels[s];
      raw[d + 1] = pixels[s + 1];
      raw[d + 2] = pixels[s + 2];
      if (alpha) raw[d + 3] = pixels[s + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // color type
  // 10=compression 11=filter 12=interlace 皆為 0

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 自四邊各切除指定的像素數 */
export function crop(src, { left = 0, top = 0, right = 0, bottom = 0 }) {
  const width = src.width - left - right;
  const height = src.height - top - bottom;
  if (width <= 0 || height <= 0) throw new Error('裁切之後沒有東西剩下了');

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y + top) * src.width + left) * 4;
    src.pixels.copy(pixels, y * width * 4, from, from + width * 4);
  }
  return { width, height, pixels };
}

/**
 * 縮放至指定大小。採區域平均(box filter)而非取最近點 ——
 * 截圖中的文字以最近點縮小會糊成鋸齒,那是商店截圖最忌諱的。
 */
export function resizeTo(src, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  const scaleX = src.width / width;
  const scaleY = src.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));

    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const s = (sy * src.width + sx) * 4;
          r += src.pixels[s];
          g += src.pixels[s + 1];
          b += src.pixels[s + 2];
          count += 1;
        }
      }

      const d = (y * width + x) * 4;
      pixels[d] = Math.round(r / count);
      pixels[d + 1] = Math.round(g / count);
      pixels[d + 2] = Math.round(b / count);
      pixels[d + 3] = 255;
    }
  }

  return { width, height, pixels };
}

/**
 * 等比縮至恰好放得進 width×height,四周以 bg 補滿,圖片置中。
 *
 * 不直接拉伸成目標比例的原因:文字會變胖或變扁,一眼即可看出廉價。
 * 不裁切的原因:裁去的可能正好是重點。
 * 補邊最為安全 —— 底色與畫面接近時,看起來便像本來就是這個比例。
 */
export function fitInto(src, width, height, bg) {
  /*
   * 只縮不放。
   *
   * 截圖放大必然模糊 —— 那些像素本就不存在,再好的演算法亦屬推測。
   * 留白至少是誠實的:畫面較小,但每個字都清晰。
   * 商店的圖被人放大檢視時,模糊遠比留白難看。
   */
  const scale = Math.min(width / src.width, height / src.height, 1);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const scaled = resizeTo(src, w, h);

  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = bg.r;
    pixels[i * 4 + 1] = bg.g;
    pixels[i * 4 + 2] = bg.b;
    pixels[i * 4 + 3] = 255;
  }

  const offsetX = Math.floor((width - w) / 2);
  const offsetY = Math.floor((height - h) / 2);
  for (let y = 0; y < h; y += 1) {
    const from = y * w * 4;
    scaled.pixels.copy(pixels, ((y + offsetY) * width + offsetX) * 4, from, from + w * 4);
  }

  return { width, height, pixels, scale, inner: { width: w, height: h } };
}

/**
 * 取四邊最常見的顏色作為補邊的底色。
 *
 * 寫死一個深灰亦可,但 Spotify 的歌詞頁底色是隨專輯封面變動的。
 * 取樣才能使補上的邊與畫面融為一體,看不出是補的。
 */
export function edgeColor({ width, height, pixels }) {
  const counts = new Map();
  const sample = (x, y) => {
    const s = (y * width + x) * 4;
    const key = `${pixels[s]},${pixels[s + 1]},${pixels[s + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }

  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = best[0].split(',').map(Number);
  return { r, g, b };
}
