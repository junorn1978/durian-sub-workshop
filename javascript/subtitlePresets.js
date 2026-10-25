/**
 * @file subtitlePresets.js
 * @description 字幕の配色：一次換掉四行字幕的文字色、縁取り色、縁取りサイズ。
 *              從姊妹專案（即時翻譯 v1.32.0）移植，那邊只有三行，翻訳 3 是這邊補的。
 *
 * 配色只是資料，不是 CSS。套用時把值寫進設定畫面的 input，再派送 'input' 事件，
 * 存檔、CSS 變數、色塊按鈕全都照手動改色的路走（見 settingsBindings.js、colorPicker.js），
 * 所以下游不需要知道有配色這回事。也因此沒有「目前的配色」這個設定：
 * 目前的值剛好和哪一組一樣，就是哪一組；之後手動改了顏色，自然就哪組都不是。
 *
 * 刻意不動的：
 *  - 文字サイズ：看解析度和版面，不是看風格。
 *  - 背景色：ウィンドウキャプチャ時是クロマキー的顏色，動了會抜けなくなる。
 *
 * 不用偏綠的顏色：背景預設是 #00FF00，類似度調高時薄荷綠、草綠會被一起抜掉。
 *
 * 名稱刻意用一般詞。有些配色參考了知名角色的配色，但不寫出角色名稱與商標。
 *
 * 這個模組最上層不碰 DOM：OBS連携 的視窗只拿 PRESETS 來列選單（見 obsSceneLink.js）。
 */

/* 每一行字幕的 input id 前綴，與配色裡的欄位。 */
const LINES = [['source', 'src'], ['target1', 't1'], ['target2', 't2'], ['target3', 't3']];

const line = (color, stroke, w) => ({ color, stroke, w });

/* default 是 CSS 的預設值（--text-color／--stroke-color／--stroke-width），也就是「恢復原狀」。 */
export const PRESETS = [
  { id: 'default',   name: 'デフォルト',
    src: line('#FFFFFF', '#000000', 5), t1: line('#FFFFFF', '#000000', 5), t2: line('#FFFFFF', '#000000', 5), t3: line('#FFFFFF', '#000000', 5) },
  { id: 'standard',  name: 'スタンダード',
    src: line('#FFFFFF', '#000000', 4), t1: line('#FFE873', '#000000', 4), t2: line('#9FD4FF', '#000000', 4), t3: line('#FFB3C7', '#000000', 4) },
  { id: 'game',      name: 'ゲーム',
    src: line('#FFFFFF', '#0A0F2C', 6), t1: line('#FFD400', '#0A0F2C', 6), t2: line('#4FE3FF', '#0A0F2C', 6), t3: line('#FF8A3D', '#0A0F2C', 6) },
  { id: 'cute',      name: 'かわいい',
    src: line('#FFFFFF', '#5A1E3C', 4), t1: line('#FF8FB1', '#5A1E3C', 4), t2: line('#B79CFF', '#5A1E3C', 4), t3: line('#FFD27F', '#5A1E3C', 4) },
  { id: 'pastel',    name: 'ゆめかわ',
    src: line('#7A2E55', '#FFFFFF', 5), t1: line('#9B3F8A', '#FFFFFF', 5), t2: line('#4B4BA8', '#FFFFFF', 5), t3: line('#A23B5B', '#FFFFFF', 5) },
  { id: 'imp',       name: '小悪魔',
    src: line('#FFFFFF', '#241A2E', 5), t1: line('#CDA8FF', '#241A2E', 5), t2: line('#FF7EB9', '#241A2E', 5), t3: line('#9FB8FF', '#241A2E', 5) },
  { id: 'berrymilk', name: 'いちごミルク',
    src: line('#FFFFFF', '#C8336F', 5), t1: line('#FFC2DA', '#A82A5E', 5), t2: line('#FFF1A8', '#A82A5E', 5), t3: line('#FFE0EC', '#A82A5E', 5) },
  { id: 'contrast',  name: 'ハイコントラスト',
    src: line('#FFFFFF', '#000000', 7), t1: line('#FFFF00', '#000000', 7), t2: line('#7FDBFF', '#000000', 7), t3: line('#FFB0E0', '#000000', 7) },
  { id: 'retro',     name: 'レトロ',
    src: line('#F3E6C8', '#3B2414', 5), t1: line('#F2B45A', '#3B2414', 5), t2: line('#E89A7C', '#3B2414', 5), t3: line('#D9C27A', '#3B2414', 5) },
  /* 這個配信者料理配信時用的配色：白い縁取りに、行ごとに濃い色（原文は紫がかった墨色、紫・赤・青）。 */
  { id: 'cooking',   name: '料理配信',
    src: line('#4B3B63', '#FFFFFF', 4), t1: line('#8A2BE2', '#FFFFFF', 4), t2: line('#E0201E', '#FFFFFF', 4), t3: line('#2457D6', '#FFFFFF', 4) },
];

/** 套用之後要做的事（主視窗：馬上推給 OBS 的 overlay）。由 mountSubtitlePresets() 設定。 */
let afterApply = () => {};
/** 選單的打勾狀態。由 mountSubtitlePresets() 設定。 */
let syncMenu = () => {};

const inputsOf = (prefix) => ({
  color: document.getElementById(`${prefix}-font-color`),
  stroke: document.getElementById(`${prefix}-font-stroke-color`),
  w: document.getElementById(`${prefix}-font-stroke-size`)
});

/* 寫進 input 並派送事件，讓設定綁定與色塊按鈕照手動操作的路處理。 */
function setInput(el, value) {
  if (!el) return;
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function apply(preset) {
  for (const [prefix, slot] of LINES) {
    const inputs = inputsOf(prefix);
    setInput(inputs.color, preset[slot].color);
    setInput(inputs.stroke, preset[slot].stroke);
    setInput(inputs.w, preset[slot].w);
  }
  syncMenu();
  afterApply();
}

function matches(preset) {
  return LINES.every(([prefix, slot]) => {
    const inputs = inputsOf(prefix);
    // input[type="color"] 的 value 一律是小寫。
    return inputs.color?.value.toUpperCase() === preset[slot].color &&
      inputs.stroke?.value.toUpperCase() === preset[slot].stroke &&
      Number(inputs.w?.value) === preset[slot].w;
  });
}

/**
 * 依 id 套用配色（主視窗：シーン連動 切換場景時）。
 * @returns {boolean} 沒有這個 id（規則存下之後配色被拿掉了）時回傳 false，什麼都不改
 */
export function applyPreset(id) {
  const preset = PRESETS.find(p => p.id === id);
  if (preset) apply(preset);
  return !!preset;
}

/* 每一項用自己配色的翻訳 1 畫出名稱（原文大多是白色），再加四個點表示四行的文字色，
   選單本身就是預覽。 */
function buildItem(preset) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'subtitle-preset-item';
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', 'false');
  item.dataset.preset = preset.id;
  item.style.setProperty('--p-color', preset.t1.color);
  item.style.setProperty('--p-stroke', preset.t1.stroke);

  const name = document.createElement('span');
  name.className = 'subtitle-preset-name';
  name.textContent = preset.name;

  const dots = document.createElement('span');
  dots.className = 'subtitle-preset-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (const [, slot] of LINES) {
    const dot = document.createElement('i');
    dot.style.background = preset[slot].color;
    dots.append(dot);
  }

  item.append(name, dots);
  return item;
}

/**
 * 主視窗：在 #subtitle-preset-menu 裡畫出配色選單並接上。
 * @param {{ onApplied?: () => void }} [options] onApplied：套用配色之後呼叫
 * @returns {{ sync: () => void }} sync：設定被程式改掉（全部重設）之後，重新對打勾
 */
export function mountSubtitlePresets({ onApplied = () => {} } = {}) {
  afterApply = onApplied;
  const menu = document.getElementById('subtitle-preset-menu');
  if (!menu) return { sync() {} };

  const head = document.createElement('span');
  head.className = 'subtitle-preset-head';
  head.textContent = '字幕テーマ';
  const grid = document.createElement('div');
  grid.className = 'subtitle-preset-grid';
  const items = PRESETS.map(buildItem);
  grid.append(...items);
  menu.append(head, grid);

  syncMenu = () => {
    for (const item of items) {
      const preset = PRESETS.find(p => p.id === item.dataset.preset);
      item.setAttribute('aria-checked', String(!!preset && matches(preset)));
    }
  };

  for (const item of items) {
    item.addEventListener('click', () => {
      applyPreset(item.dataset.preset);
      menu.hidePopover();
    });
  }

  /* 手動改了顏色或縁取り，打勾就跟著變。 */
  for (const [prefix] of LINES) {
    for (const el of Object.values(inputsOf(prefix))) el?.addEventListener('input', () => syncMenu());
  }

  syncMenu();
  return { sync: () => syncMenu() };
}
