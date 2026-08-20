/**
 * active-line.js
 * 找出「正在唱的那一行」,用來決定先轉換哪一行。
 *
 * 為什麼需要:kuromoji 斷詞是同步的 CPU 工作,一次 40 行不可能瞬間轉完。
 * 如果照 DOM 順序處理,正在唱的那一行會排在它上面所有(已經唱過的)行後面,
 * 使用者就會看到拼音慢半拍才出現。知道哪一行是重點,就能讓它插隊。
 *
 * ── 實測紀錄(2026-07,Spotify 網頁版)────────────────────────────
 * 掛 MutationObserver 觀察 30 秒,Spotify 在歌詞行上**完全沒有**任何
 * 屬性或 class 變動;所有行的 computed opacity 都是 0.5、color 完全相同。
 * 但畫面上正在唱的那一行確實會變亮並跟著歌走。
 *
 * 結論:高亮不是逐行的狀態,而是「位置」造成的(整個容器上蓋漸層/遮罩,
 * 位在焦點的那行就亮)。所以幾何判斷才是對的做法。
 *
 * 這反而比抓 class 名稱耐用 —— 這個擴充功能已經被 Spotify 改版
 * (lyrics-line-always-visible → lyrics-line)打壞過一次,
 * 幾何位置不會因為改版而失效。
 *
 * 還是保留了屬性/class 的判斷放在前面,萬一哪天 Spotify 加回明確標記,
 * 不用改程式就會自動改用比較準的那個。
 */

const LOG = '[romaji]';

/** 我們自己加的屬性,判斷時必須跳過,否則會自己回饋自己 */
const OWN_ATTR_PREFIX = 'data-romaji';

/**
 * 判斷結果的快取有效期。
 * getComputedStyle / getBoundingClientRect 都會逼瀏覽器重算版面,不能每次都問。
 * 要比呼叫端的更新節奏(ACTIVE_TICK_MS)略短,否則等於白做一次。
 */
const CACHE_MS = 100;

let winningStrategy = null;
let missStreak = 0;
let cachedIndex = -1;
let cachedAt = 0;

/* ----------------------------------------------------------- 各種策略 */

/** 明確的無障礙標記,最可信 */
function byAriaCurrent(lines) {
  return lines.findIndex((el) => {
    const value = el.getAttribute('aria-current');
    return value !== null && value !== 'false';
  });
}

/** class 裡有 active / current / highlight / playing 之類的字樣 */
function byClassName(lines) {
  const re = /(^|[-_])(active|current|highlight|playing|sung)([-_]|$)/i;
  const hits = lines.filter((el) => [...el.classList].some((token) => re.test(token)));
  return hits.length === 1 ? lines.indexOf(hits[0]) : -1;
}

/** 只有一行帶著某個值為 "true" 的 data-* 屬性(排除我們自己加的) */
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

/** 只有一行特別不透明(其他行被調暗) */
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

  // 全部一樣(實測就是這種情況)代表這個訊號沒有資訊量
  return tie || best < 0 ? -1 : best;
}

/**
 * 取得這一行裡「Spotify 自己的那個元素」。
 *
 * 我們把原文搬進 .romaji-original 之後,Spotify 原本的內層元素還在裡面。
 * 高亮的樣式是套在那個內層元素上,不是套在歌詞行本身 ——
 * 這就是為什麼直接量歌詞行的 color/opacity 每一行都一模一樣。
 */
function spotifyInner(lineEl) {
  const original = lineEl.querySelector(':scope > .romaji-original');
  const scope = original ?? lineEl;
  return scope.firstElementChild ?? scope;
}

/**
 * 內層元素的樣式跟其他行不一樣的那一行。
 *
 * 實測:純拼音模式下原文被藏起來,看不到 Spotify 的高亮;
 * 但原文混合模式下,正在唱的那句日文是白的、其餘是灰的。
 * 也就是說高亮確實存在,只是在內層。這裡就是去讀它。
 *
 * 用「只有一行是這個樣式」來判斷,不寫死任何顏色值 ——
 * Spotify 換配色或換主題都不會壞。
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

  // 需要至少兩種樣式,而且目標樣式只有一行有 —— 否則沒有鑑別力
  if (counts.size < 2) return -1;
  const unique = [...counts].filter(([, count]) => count === 1);
  if (unique.length !== 1) return -1;

  return signatures.indexOf(unique[0][0]);
}

/**
 * 往上找真正會捲動的那個祖先。
 * auto-scroll.js 也要用同一個判斷 —— 標記高亮跟自動置中必須認定同一個容器,
 * 各找各的話會在 Spotify 改版時默默分岔。
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
 * 幾何:最接近焦點的那一行。
 *
 * Spotify 會自動把正在唱的那行捲到固定位置,所以「誰在焦點上」
 * 就等於「誰正在被唱」。沒有可捲動祖先時退回用視窗中心。
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
    if (rect.height === 0) return; // 還沒排版好的跳過
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
  ['inner-style', byInnerStyle], // 實測有效:高亮在內層元素上
  ['opacity', byUniqueOpacity],
  ['geometry', byGeometry], // 最後的保險,不依賴任何 Spotify 的實作細節
];

/* ----------------------------------------------------------- 對外介面 */

/**
 * 找出正在唱的那一行的索引。
 * @param {HTMLElement[]} lines
 * @returns {number} 找不到時回 -1
 */
export function findActiveIndex(lines) {
  if (!lines.length) return -1;

  const now = performance.now();
  if (now - cachedAt < CACHE_MS) return cachedIndex;

  // 先試上次贏的那個策略,省下每次重跑整條鏈的成本
  if (winningStrategy) {
    const entry = STRATEGIES.find(([name]) => name === winningStrategy);
    const index = entry ? entry[1](lines) : -1;
    if (index >= 0) {
      missStreak = 0;
      cachedIndex = index;
      cachedAt = now;
      return index;
    }
    // 連續失敗兩次才重新探測,避免偶爾一次抖動就整條鏈重跑
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
    // 記錄一次,日後 Spotify 改版時從 Console 就能看出換了哪個策略
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
 * 把 data-romaji-active="true" 標在正在唱的那一行上。
 *
 * 這個屬性是佇列排序唯一的優先權訊號 —— 排序時只要讀屬性,
 * 不必再跑一次(會觸發版面重算的)幾何判斷。
 *
 * @param {HTMLElement[]} lines
 * @returns {number} 標記的索引,-1 代表判斷不出來
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
