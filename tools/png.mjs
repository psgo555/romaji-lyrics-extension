/**
 * png.mjs
 * 最小的 PNG 讀寫,不依賴任何套件。
 *
 * ── 為什麼不裝影像套件 ────────────────────────────────────────
 * 這個專案的 dependencies 會被打包進擴充功能,而使用者要能相信
 * 「這東西沒有偷做什麼」。多裝一個套件,對讀原始碼的人就是多一個要查的東西,
 * 而我們只需要 PNG 的一小部分功能。
 *
 * 支援範圍刻意很窄:8 bit、非交錯。截圖工具與瀏覽器存出來的都是這種。
 * 遇到別的就明白報錯 —— 不要靜靜地輸出一張色彩壞掉的圖。
 *
 * 註:tools/make-icons.mjs 裡有一份更早、只處理方形的複本。那支是一次性的
 * (圖示已經產好了),而且它一被 import 就會重新產生圖示,所以不能直接沿用。
 * 下次真的要動它時再改成用這裡的。
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
 * 把每一列的濾波還原。
 * PNG 每一列可以選一種「跟左邊/上面的差值」來存,沒還原就直接讀,顏色會整片糊掉。
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
 * @returns {{width: number, height: number, pixels: Buffer}} pixels 一律是 RGBA
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

      // 0=灰階 2=RGB 4=灰階+透明 6=RGBA。3(調色盤)沒支援,截圖不會是那種。
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

  // 一律轉成 RGBA,後面就只要面對一種格式
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
 * @param {{width: number, height: number, pixels: Buffer}} image pixels 是 RGBA
 * @param {{alpha?: boolean}} [options] 預設不含透明 —— Chrome 線上應用程式商店的
 *   截圖**不接受含透明色版的 PNG**,所以預設就存成 24 bit。
 */
export function encodePng({ width, height, pixels }, { alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 不做濾波,單純一點
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
  // 10=compression 11=filter 12=interlace 都是 0

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 從四邊各切掉指定的像素 */
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
 * 縮放到指定大小。用區域平均(box filter)而不是取最近的點 ——
 * 截圖裡的文字用最近點縮小會糊成鋸齒,那是商店截圖最忌諱的。
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
 * 等比縮到剛好放得進 width×height,四周用 bg 補滿,圖置中。
 *
 * 為什麼不直接拉伸成目標比例:字會變胖或變扁,一眼就看得出廉價。
 * 為什麼不裁切:裁掉的可能正好是重點。
 * 補邊最安全 —— 底色跟畫面接近的話,看起來就像本來就是這個比例。
 */
export function fitInto(src, width, height, bg) {
  /*
   * 只縮不放。
   *
   * 截圖放大一定會糊 —— 那些像素本來就不存在,再好的演算法也是猜的。
   * 留白至少是誠實的:畫面小,但每個字都是清楚的。
   * 商店的圖被人放大看的時候,糊掉比留白難看得多。
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
 * 取四邊最常見的顏色,當補邊的底色。
 *
 * 寫死一個深灰也行,但 Spotify 的歌詞頁底色是跟著專輯封面變的。
 * 取樣才能讓補的邊跟畫面融在一起,看不出是補的。
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
