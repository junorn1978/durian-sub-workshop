/**
 * @file subtitleCloud.js
 * @description 雲的縁取り（バブル／もこもこ）：每一行字幕的字放在一朵縁取り色的雲上，
 *              外面再圍一圈外枠色。相鄰的字膨成同一朵雲，只在「、」「。」或單字之間的空隙斷開。
 *              從姊妹專案（即時翻譯 v1.35.0 的 js/subtitle-cloud.js）移植，那邊只有三行，翻訳 3 是這邊補的。
 *
 * 為什麼用 SVG filter 而不是 -webkit-text-stroke：stroke 只能畫一種顏色、轉角是尖的，
 * 粗了以後假名的角會長刺；疊兩層字來畫第二種顏色，每個字的外枠又會壓到隔壁字的雲上。
 * filter 是把整行字的形狀一起膨脹，聯集自然就有了。
 *
 * 兩種樣式只差在「字怎麼膨成雲」（SHAPES）；外枠、顏色、三個數值（雲的大小、外枠寬、外枠色）
 * 是共用的，所以換樣式時外觀能整組帶過去。
 *
 * 會畫字幕的文件各自裝一份 filter（url(#id) 只在同一份文件裡解析得到）：
 *  - 主視窗（index.html）：uiController.js 呼叫 installCloudFilters()，數值從設定畫面的 input 讀（syncCloudFromInputs）。
 *  - OBS 的 overlay（obs_overlay.html）：數值從 obsBridge.js 送來的樣式讀（updateCloudFilters）。
 * 這個模組最上層不碰 DOM，overlay 也能直接 import。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const CLOUD_OUTLINES = ['bubble', 'gooey'];

/** 每一行在設定畫面的 input id 前綴，也是 filter id 的一部分。 */
export const CLOUD_LINES = ['source', 'target1', 'target2', 'target3'];

/** 縁取りの種類 的設定值是不是雲的樣式。'stroke'（一般的縁取り）與其他未知的值都不是。 */
export const isCloudOutline = (outline) => CLOUD_OUTLINES.includes(outline);

/** 縁取りの種類が変わったときに document に飛ぶ事件（settingsBindings.js が出す）。
 *  字幕テーマのメニューと OBS への再送が聞く。 */
export const SUBTITLE_OUTLINE_EVENT = 'subtitle-outline-change';

export const cloudFilterId = (outline, line) => `sub-${outline}-${line}`;

/**
 * 一行的雲與外枠，單位 px。兩者都跟著文字大小走，所以改字的大小時外觀不變；
 * 兩個寬度設定（0〜15 的級數）只決定雲胖一點或瘦一點、外枠粗一點或細一點。
 * 外枠 0 就是沒有；其他值至少 1px，不然字小的時候會消失。
 */
export function cloudGeometry(sizePx, width, rimWidth = 3) {
  return {
    radius: sizePx * (0.08 + 0.02 * width),
    rim:    rimWidth > 0 ? Math.max(1, sizePx * 0.02 * rimWidth) : 0,
  };
}

/* 在 alpha 一半的地方切開，留一小段斜坡：邊緣俐落但仍有反鋸齒。 */
const CUT_HALF = '<feFuncA type="linear" slope="8" intercept="-3.5"/>';

/* 每種樣式怎麼把 SourceAlpha 膨成 result="cloud"，以及怎麼跟著雲的半徑調整。 */
const SHAPES = {
  /* 圓潤平均：三個矩形膨脹（寬、高、以及到圓對角線的正方形）聯集成八角形，
     再用小模糊在 alpha 一半處切開，把剩下的角磨圓。
     姊妹專案的原型實測：1920 寬的一行，每次更新約 0.6ms 的 GPU 時間。 */
  bubble: {
    markup: `
      <feMorphology in="SourceAlpha" operator="dilate" data-k="1 0.41" result="d1"/>
      <feMorphology in="SourceAlpha" operator="dilate" data-k="0.41 1" result="d2"/>
      <feMorphology in="SourceAlpha" operator="dilate" data-k="0.71 0.71" result="d3"/>
      <feMerge result="du"><feMergeNode in="d1"/><feMergeNode in="d2"/><feMergeNode in="d3"/></feMerge>
      <feGaussianBlur in="du" data-blur="cloud" result="db"/>
      <feComponentTransfer in="db" result="cloud">${CUT_HALF}</feComponentTransfer>`,
    update(filter, g) {
      filter.querySelectorAll('[data-k]').forEach((el) => {
        const [kx, ky] = el.dataset.k.split(' ').map(Number);
        el.setAttribute('radius', `${(g.radius * kx).toFixed(2)} ${(g.radius * ky).toFixed(2)}`);
      });
      filter.querySelector('[data-blur="cloud"]').setAttribute('stdDeviation', Math.max(1, g.radius * 0.25).toFixed(2));
    },
  },

  /* 凹凸不平：字先大幅模糊、在很低的 alpha 處切開，所以筆畫密的地方膨得比細的地方遠，
     輪廓像從管子擠出來的。只切低處邊緣會又軟又寬，所以再用一次短模糊在一半處切銳利。
     模糊寬度等於雲的半徑、切在 3〜6% 的 alpha，膨脹距離和同一設定的バブル差不多。
     比バブル 重：原型裡模糊只有這個的六成寬時是 1.7ms，更寬的沒量過。 */
  gooey: {
    markup: `
      <feGaussianBlur in="SourceAlpha" data-blur="goo" result="gb"/>
      <feComponentTransfer in="gb" result="gc"><feFuncA type="linear" slope="30" intercept="-0.9"/></feComponentTransfer>
      <feGaussianBlur in="gc" stdDeviation="1" result="gs"/>
      <feComponentTransfer in="gs" result="cloud">${CUT_HALF}</feComponentTransfer>`,
    update(filter, g) {
      filter.querySelector('[data-blur="goo"]').setAttribute('stdDeviation', g.radius.toFixed(2));
    },
  },
};

/* filter 的範圍按元素大小的比例往外延。雲和外枠都開到最大（15 與 15）時會超出字形 0.68em，
   一行的高度是 1.55em，它的 60% 是 0.93em，上下不會被切掉。
   主視窗的字幕行橫跨整個面板，左右 5% 就夠；overlay 的行會縮到文字寬，由它自己加左右 padding 容納雲。
   形狀之後的部分都共用：從雲長出外枠、兩種顏色、最上面疊原本的字。 */
const filterMarkup = (outline, line) => `
  <filter id="${cloudFilterId(outline, line)}" x="-5%" y="-60%" width="110%" height="220%" color-interpolation-filters="sRGB">
    ${SHAPES[outline].markup}
    <feMorphology in="cloud" operator="dilate" data-rim="" result="ru"/>
    <feGaussianBlur in="ru" data-blur="rim" result="rb"/>
    <feComponentTransfer in="rb" result="rim">${CUT_HALF}</feComponentTransfer>
    <feFlood data-flood="rim" result="rf"/>
    <feComposite in="rf" in2="rim" operator="in" result="rimC"/>
    <feFlood data-flood="cloud" result="cf"/>
    <feComposite in="cf" in2="cloud" operator="in" result="cloudC"/>
    <feMerge><feMergeNode in="rimC"/><feMergeNode in="cloudC"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;

/** 把每種樣式、每一行的 filter 裝進這份文件（只裝一次）。 */
export function installCloudFilters(doc = document) {
  if (doc.getElementById(cloudFilterId(CLOUD_OUTLINES[0], CLOUD_LINES[0]))) return;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  svg.innerHTML = `<defs>${CLOUD_OUTLINES.flatMap(outline =>
    CLOUD_LINES.map(line => filterMarkup(outline, line))).join('')}</defs>`;
  doc.body.prepend(svg);
}

/**
 * 把一行在每種樣式下的 filter 對到目前的大小與顏色。
 * 全部樣式都更新、不只更新正在用的那個，這樣切換樣式時這裡不用重畫。
 * @param {'source'|'target1'|'target2'|'target3'} line
 * @param {{ size: number, width: number, rimWidth: number, cloud: string, rim: string }} style
 *   size 是字的大小（px）；width 與 rimWidth 是設定裡 0〜15 的級數；cloud 是雲的顏色，rim 是外枠色。
 */
export function updateCloudFilters(line, { size, width, rimWidth, cloud, rim }, doc = document) {
  if (!(size > 0)) return;
  const g = cloudGeometry(size, Number(width) || 0, Number.isFinite(rimWidth) ? rimWidth : 3);

  for (const outline of CLOUD_OUTLINES) {
    const filter = doc.getElementById(cloudFilterId(outline, line));
    if (!filter) continue;
    const set = (selector, name, value) =>
      filter.querySelectorAll(selector).forEach(el => el.setAttribute(name, value));

    SHAPES[outline].update(filter, g);
    set('[data-rim]', 'radius', g.rim.toFixed(2));
    set('[data-blur="rim"]', 'stdDeviation', Math.max(0.6, g.rim * 0.4).toFixed(2));
    /* 沒有外枠時，那一層仍然是雲本身的形狀（切得更銳利），會在雲的反鋸齒邊緣露出一圈毛邊。 */
    set('[data-flood="rim"]', 'flood-opacity', g.rim > 0 ? 1 : 0);
    if (cloud) set('[data-flood="cloud"]', 'flood-color', cloud);
    if (rim)   set('[data-flood="rim"]', 'flood-color', rim);
  }
}

/**
 * 主視窗：一行在雲模式下的樣式，從設定畫面的 input 讀。obsBridge.js 送給 overlay 的也是這組值。
 * @param {string} line CLOUD_LINES 之一
 */
export function cloudStyleFromInputs(line, doc = document) {
  const value = (id) => doc.getElementById(id)?.value;
  return {
    textColor: value(`${line}-cloud-text-color`) || '#FFFFFF',
    cloud:     value(`${line}-cloud-color`) || '#000000',
    rim:       value(`${line}-cloud-rim-color`) || '#FFFFFF',
    width:     Number(value(`${line}-cloud-size`) ?? 6),
  };
}

/** 主視窗：外枠寬（四行共用）。 */
export const rimWidthFromInputs = (doc = document) => Number(doc.getElementById('cloud-rim-width-opt')?.value ?? 3);

/** 主視窗：依設定畫面的 input 更新四行的 filter。字的大小、雲的設定、外枠寬任何一個改了都要呼叫。 */
export function syncCloudFromInputs(doc = document) {
  const rimWidth = rimWidthFromInputs(doc);
  for (const line of CLOUD_LINES) {
    const style = cloudStyleFromInputs(line, doc);
    updateCloudFilters(line, {
      size: parseFloat(doc.getElementById(`${line}-font-size`)?.value),
      width: style.width,
      rimWidth,
      cloud: style.cloud,
      rim: style.rim,
    }, doc);
  }
}
