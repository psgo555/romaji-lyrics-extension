/**
 * active-line.js
 * 判定目前演唱中的歌詞行,用於決定轉換順序。
 *
 * kuromoji 斷詞為同步的 CPU 工作,一次 40 行無法即時完成。若依 DOM 順序處理,
 * 演唱中的行會排在其上方所有已唱過的行之後,拼音因而延遲出現。取得該行的位置
 * 即可讓它優先處理。
 *
 * 實測結果(2026-07,Spotify 網頁版):以 MutationObserver 觀察 30 秒,Spotify
 * 在歌詞行上沒有任何屬性或 class 變動;所有行的 computed opacity 皆為 0.5,
 * color 完全相同。但畫面上演唱中的行確實會變亮並隨歌曲移動。
 *
 * 據此判斷,高亮並非逐行的狀態,而是位置造成的效果 —— 容器整體套上漸層或遮罩,
 * 位於焦點的行因而變亮。幾何判斷才是正確的作法。
 *
 * 該作法亦較比對 class 名稱耐用:本擴充功能曾因 Spotify 改版
 * (lyrics-line-always-visible → lyrics-line)而失效一次,幾何位置不受改版影響。
 *
 * 屬性與 class 的判斷仍保留於鏈的前段:Spotify 日後若加回明確標記,
 * 無須修改程式即會自動改用精確度較高的策略。
 */

const LOG = '[romaji]';

/** 本擴充功能自身的屬性前綴,判斷時必須排除,否則會形成自我回饋 */
const OWN_ATTR_PREFIX = 'data-romaji';

/**
 * 判斷結果的快取有效期。
 * getComputedStyle 與 getBoundingClientRect 皆會觸發版面重算,不宜每次呼叫。
 * 須略短於呼叫端的更新節奏(ACTIVE_TICK_MS),否則等同無效。
 */
const CACHE_MS = 100;

let winningStrategy = null;
let missStreak = 0;
let cachedIndex = -1;
let cachedAt = 0;

/* ----------------------------------------------------------- 各種策略 */

/** 明確的無障礙標記,可信度最高 */
function byAriaCurrent(lines) {
  return lines.findIndex((el) => {
    const value = el.getAttribute('aria-current');
    return value !== null && value !== 'false';
  });
}

/** class 中含 active / current / highlight / playing 等字樣 */
function byClassName(lines) {
  const re = /(^|[-_])(active|current|highlight|playing|sung)([-_]|$)/i;
  const hits = lines.filter((el) => [...el.classList].some((token) => re.test(token)));
  return hits.length === 1 ? lines.indexOf(hits[0]) : -1;
}

/** 僅有一行帶有值為 "true" 的 data-* 屬性(排除本擴充功能自身的屬性) */
function byUniqueDataAttr(lines) {
  const counts = new Map();
  for (const el of lines) {
    for (const attr of el.attributes) {
      if (attr.value !== 'true') continue;
      if (!attr.name.startsWith('data-') || attr.name.startsWith(OWN_ATTR_PREFIX)) continue;
      counts.set(attr.name, (counts.get(attr.name) ?? 0) + 1);
    }
  }
  for (const [name, count] of counts) {
    if (count !== 1) continue;
    return lines.findIndex((el) => el.getAttribute(name) === 'true');
  }
  return -1;
}

/** 僅有一行未被調暗 */
function byUniqueOpacity(lines) {
  let best = -1;
  let bestValue = -Infinity;
  let tie = false;

  lines.forEach((el, index) => {
    const value = Number.parseFloat(getComputedStyle(el).opacity);
    if (!Number.isFinite(value)) return;
    if (value > bestValue) {
      bestValue = value;
      best = index;
      tie = false;
    } else if (value === bestValue) {
      tie = true;
    }
  });

  // 全部相同(實測即為此情況)表示此訊號沒有鑑別力
  return tie || best < 0 ? -1 : best;
}

/**
 * 取得該行中屬於 Spotify 的元素。
 *
 * 原文被移入 .romaji-original 後,Spotify 原有的內層元素仍在其中。高亮樣式套用於
 * 該內層元素而非歌詞行本身,這即是直接量測歌詞行的 color 與 opacity 時每行皆相同
 * 的原因。
 */
function spotifyInner(lineEl) {
  const original = lineEl.querySelector(':scope > .romaji-original');
  const scope = original ?? lineEl;
  return scope.firstElementChild ?? scope;
}

/**
 * 內層元素樣式與其他行相異的那一行。
 *
 * 實測:純拼音模式下原文隱藏,無從觀察 Spotify 的高亮;原文混合模式下,
 * 演唱中的該句日文為白色,其餘為灰色。高亮確實存在,位置在內層元素上。
 *
 * 判定依據為「僅有一行採用此樣式」,不比對任何固定的顏色值,
 * Spotify 更換配色或主題皆不受影響。
 */
function byInnerStyle(lines) {
  const signatures = lines.map((el) => {
    const style = getComputedStyle(spotifyInner(el));
    return `${style.color}|${style.opacity}|${style.fontWeight}|${style.webkitTextFillColor}`;
  });

  const counts = new Map();
  for (const signature of signatures) {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  // 須至少存在兩種樣式,且目標樣式僅有一行採用,否則不具鑑別力
  if (counts.size < 2) return -1;
  const unique = [...counts].filter(([, count]) => count === 1);
  if (unique.length !== 1) return -1;

  return signatures.indexOf(unique[0][0]);
}

/**
 * 向上尋找實際可捲動的祖先元素。
 * auto-scroll.js 使用同一項判斷 —— 標記高亮與自動置中必須認定同一個容器,
 * 各自實作會在 Spotify 改版時安靜地分歧。
 */
export function findScrollParent(el) {
  let node = el?.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 幾何判斷:最接近焦點的行。
 *
 * Spotify 會將演唱中的行捲至固定位置,位於焦點者即為演唱中的行。
 * 無可捲動祖先時,退回以視窗中心為焦點。
 */
function byGeometry(lines) {
  const container = findScrollParent(lines[0]);
  const box = container
    ? container.getBoundingClientRect()
    : { top: 0, height: window.innerHeight };
  const focus = box.top + box.height / 2;

  let best = -1;
  let bestDistance = Infinity;

  lines.forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return; // 尚未完成排版,略過
    const distance = Math.abs(rect.top + rect.height / 2 - focus);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });

  return best;
}

const STRATEGIES = [
  ['aria-current', byAriaCurrent],
  ['class', byClassName],
  ['data-attr', byUniqueDataAttr],
  ['inner-style', byInnerStyle], // 實測有效:高亮位於內層元素
  ['opacity', byUniqueOpacity],
  ['geometry', byGeometry], // 最終保險,不依賴任何 Spotify 的實作細節
];

/* ----------------------------------------------------------- 對外介面 */

/**
 * 取得演唱中該行的索引。
 * @param {HTMLElement[]} lines
 * @returns {number} 無法判定時回 -1
 */
export function findActiveIndex(lines) {
  if (!lines.length) return -1;

  const now = performance.now();
  if (now - cachedAt < CACHE_MS) return cachedIndex;

  // 優先嘗試上次成功的策略,省去每次重跑整條鏈的成本
  if (winningStrategy) {
    const entry = STRATEGIES.find(([name]) => name === winningStrategy);
    const index = entry ? entry[1](lines) : -1;
    if (index >= 0) {
      missStreak = 0;
      cachedIndex = index;
      cachedAt = now;
      return index;
    }
    // 連續失敗兩次才重新探測,避免單次抖動導致整條鏈重跑
    if (++missStreak < 2) {
      cachedAt = now;
      return cachedIndex;
    }
    winningStrategy = null;
  }

  for (const [name, strategy] of STRATEGIES) {
    const index = strategy(lines);
    if (index < 0) continue;
    winningStrategy = name;
    missStreak = 0;
    // 記錄一次,Spotify 日後改版時可自 Console 得知策略的變化
    console.info(`${LOG} 用「${name}」判斷正在唱的那一行`);
    cachedIndex = index;
    cachedAt = now;
    return index;
  }

  cachedIndex = -1;
  cachedAt = now;
  return -1;
}

/**
 * 於演唱中的行標記 data-romaji-active="true"。
 *
 * 該屬性是佇列排序唯一的優先權訊號 —— 排序時僅需讀取屬性,
 * 無須再次執行會觸發版面重算的幾何判斷。
 *
 * @param {HTMLElement[]} lines
 * @returns {number} 標記的索引,-1 表示無法判定
 */
export function markActive(lines) {
  const index = findActiveIndex(lines);

  lines.forEach((el, i) => {
    if (i === index) {
      if (el.dataset.romajiActive !== 'true') el.dataset.romajiActive = 'true';
    } else if (el.dataset.romajiActive) {
      delete el.dataset.romajiActive;
    }
  });

  return index;
}
