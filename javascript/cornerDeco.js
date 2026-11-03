/**
 * @file cornerDeco.js
 * @description 字幕の飾り：原文（音声字幕）の最初の字の左上、または最後の字の右上に、
 *              少し傾けた絵（images/corner_deco.png）を字の後ろに置く。字の角に掛かっているように見せる。
 *
 * 絵は原文の要素の中には入れない：
 *  - 原文は最大2行で overflow: hidden、しかも下へ自動で捲るので、中に置くと切れたり一緒に流れたりする。
 *  - 雲の縁取りは要素全体の形を膨らませる SVG filter なので、中に置くと絵まで雲に包まれる。
 * そこで外側の入れ物（host）に置き、字の位置を測って合わせる。原文は中央揃えで長さも毎回変わるので、
 * 最初／最後の字の位置は Range.getClientRects() で行ごとの矩形を取り、要素の見えている範囲に入る
 * 最初の行の左端・最後の行の右端を使う（捲って隠れた行は使わない）。
 *
 * 重なり順：host（isolation: isolate）の中で z-index: -1、つまりすべての字幕の行の後ろ（各ページの CSS）。
 * 字幕の行には z-index を付けないので、行どうしの重なり順（雲が接したときの上下）は変わらない。
 *
 * 主視窗（index.html：uiController.js）と OBS の overlay（obs_overlay.html）が同じものを使う。
 * 最上層では DOM に触らない。
 */

/** 飾りの絵。主視窗と overlay は同じフォルダにあるので、どちらからも同じ相対パスで読める。 */
export const CORNER_DECO_SRC = 'images/corner_deco.png';

/** 設定値：'off'（出さない）| 'left'（最初の字の左上）| 'right'（最後の字の右上）。 */
export const CORNER_DECO_MODES = ['off', 'left', 'right'];
export const normalizeCornerDeco = (mode) => CORNER_DECO_MODES.includes(mode) ? mode : 'off';

/** 主視窗：設定が変わったときに document に飛ぶ事件（settingsBindings.js が出す）。 */
export const CORNER_DECO_EVENT = 'corner-deco-change';

/** 主視窗：いまの設定（settingsBindings.js が :root の data-corner-deco に入れる）。 */
export const cornerDecoFromRoot = (doc = document) => normalizeCornerDeco(doc.documentElement.dataset.cornerDeco);

/* 見た目の数値（字の大きさが基準）。
   SIZE_EM：絵の幅。ANCHOR_X／ANCHOR_Y：字の角を、絵の幅・高さのどこに合わせるか
   （左上のとき。右上は X を左右反転）。TILT_DEG：傾き（左上は左へ、右上は右へ）。 */
const SIZE_EM = 1.8;
const ANCHOR_X = 0.6;
const ANCHOR_Y = 0.55;
const TILT_DEG = 15;

/**
 * 飾りを host に置き、textEl の字に合わせて動かす。
 * @param {{ textEl: HTMLElement, host: HTMLElement }} params
 *   textEl は原文の要素、host は絵を置く入れ物（textEl の祖先で、位置の基準になるもの）。
 * @returns {{ setMode(mode: string): void, refresh(): void }}
 */
export function mountCornerDeco({ textEl, host }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;

  const img = doc.createElement('img');
  img.className = 'corner-deco';
  img.src = CORNER_DECO_SRC;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  img.hidden = true;
  host.prepend(img);

  let mode = 'off';
  let broken = false;
  let scheduled = false;

  /* 見えている行の矩形（ビューポート座標）。上から順。 */
  const visibleLineRects = () => {
    if (!textEl.textContent.trim()) return [];
    const box = textEl.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const range = doc.createRange();
    range.selectNodeContents(textEl);
    return [...range.getClientRects()]
      .filter(r => r.width > 0 && r.height > 0)
      /* 捲って上下に隠れた行は使わない。半分以上見えていれば見えている扱い。 */
      .filter(r => r.top + r.height / 2 >= box.top && r.top + r.height / 2 <= box.bottom);
  };

  const place = () => {
    scheduled = false;
    const rects = mode === 'off' || broken ? [] : visibleLineRects();
    if (!rects.length) { img.hidden = true; return; }

    /* 左上：一番上の行の左端。右上：一番下の行の右端。同じ高さの矩形（行の中の別の要素）もまとめて見る。 */
    const left = mode === 'left';
    const pickTop = left ? Math.min(...rects.map(r => r.top)) : Math.max(...rects.map(r => r.top));
    const line = rects.filter(r => Math.abs(r.top - pickTop) < r.height / 2);
    const cornerX = left ? Math.min(...line.map(r => r.left)) : Math.max(...line.map(r => r.right));
    const cornerY = Math.min(...line.map(r => r.top));

    const fontSize = parseFloat(win.getComputedStyle(textEl).fontSize) || 20;
    const width = fontSize * SIZE_EM;
    const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1;
    const height = width * ratio;
    const hostBox = host.getBoundingClientRect();

    const ax = left ? ANCHOR_X : 1 - ANCHOR_X;
    img.style.width = `${width}px`;
    img.style.left = `${cornerX - hostBox.left - width * ax}px`;
    /* 字幕は窓の上端近くにあり（上の余白は 20px ほど）、そのままだと絵の頭が窓の外で切れる。
       上端を越えるときは下へずらして、字に少し多めに隠れてもらう（傾けたぶんの 4px を足す）。 */
    const top = Math.max(cornerY - height * ANCHOR_Y, 4);
    img.style.top = `${top - hostBox.top}px`;
    img.style.transform = `rotate(${left ? -TILT_DEG : TILT_DEG}deg)`;
    img.hidden = false;
  };

  /* 原文は途中結果で1秒に何度も変わるので、1フレームに1回だけ測る。 */
  const refresh = () => {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(place);
  };

  img.addEventListener('load', refresh);
  img.addEventListener('error', () => { broken = true; img.hidden = true; });

  new MutationObserver(refresh).observe(textEl, { childList: true, characterData: true, subtree: true });
  textEl.addEventListener('scroll', refresh, { passive: true });
  /* overlay の行は出るときに少し下から浮き上がる（transform の動き）。止まった位置で測り直す。 */
  textEl.addEventListener('animationend', refresh);
  const resize = new ResizeObserver(refresh);
  resize.observe(textEl);
  resize.observe(host);
  win.addEventListener('resize', refresh);
  doc.fonts?.addEventListener?.('loadingdone', refresh);
  /* 字の大きさ・字体（雲の切り替え）・揃え・行間は style や class、:root の属性で変わり、上の監視では拾えない。
     絵自身の style は place() が書くので、それには反応しない（反応すると毎フレーム測り続ける）。 */
  new MutationObserver((records) => {
    if (records.some(r => r.target !== img)) refresh();
  }).observe(doc.documentElement, { attributes: true, subtree: true, attributeFilter: ['style', 'class', 'data-sub-outline', 'data-outline', 'lang'] });

  return {
    setMode(next) {
      mode = normalizeCornerDeco(next);
      refresh();
    },
    refresh,
  };
}
