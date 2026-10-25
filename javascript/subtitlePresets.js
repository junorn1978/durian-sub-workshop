/**
 * @file subtitlePresets.js
 * @description 字幕テーマ：一次換掉四行字幕的文字色與縁取り色。
 *              從姊妹專案（即時翻譯 v1.32.0）移植，那邊只有三行，翻訳 3 是這邊補的。
 *
 * 配色只是資料，不是 CSS。套用時把值寫進設定畫面的 input，再派送 'input' 事件，
 * 存檔、CSS 變數、色塊按鈕全都照手動改色的路走（見 settingsBindings.js、colorPicker.js），
 * 所以下游不需要知道有配色這回事。也因此沒有「目前的配色」這個設定：
 * 目前的值剛好和哪一組一樣，就是哪一組；之後手動改了顏色，自然就哪組都不是。
 *
 * 只換顏色，刻意不動的：
 *  - 文字サイズ、縁取りサイズ：看解析度、版面和個人習慣，不是看風格。
 *    姊妹專案的配色連縁取り寬度一起換，這邊拿掉了——換主題時大小不該跟著跳。
 *  - 背景色：ウィンドウキャプチャ時是クロマキー的顏色，動了會抜けなくなる。
 *
 * 不用偏綠的顏色：背景預設是 #00FF00，類似度調高時薄荷綠、草綠會被一起抜掉。
 *
 * 名稱刻意用一般詞。有些配色參考了知名角色的配色，但不寫出角色名稱與商標。
 *
 * 【マイテーマ】另外有三格讓使用者存自己目前的顏色（同樣只存文字色與縁取り色）。
 * 存在 'subtitle-custom-themes'，和字幕外觀一樣每個視窗各一份。
 * シーン連動 也能選這三格；選了空的格子，切場景時就維持原本的顏色。
 * 「全部重設」不清這三格：和翻訳クラウド接続 的 URL 一樣，是使用者自己做出來的東西。
 *
 * 這個模組最上層不碰 DOM：OBS連携 的視窗只拿 PRESETS／CUSTOM_SLOTS 來列選單（見 obsSceneLink.js）。
 */

import { getSetting, setSetting } from './settingsStore.js';

/* 每一行字幕的 input id 前綴，與配色裡的欄位。 */
const LINES = [['source', 'src'], ['target1', 't1'], ['target2', 't2'], ['target3', 't3']];

const line = (color, stroke) => ({ color, stroke });

/* default 是 CSS 的預設值（--text-color／--stroke-color），也就是「恢復原狀」。 */
/* 名稱照看起來的樣子取（從姊妹專案搬來時的名稱，拿掉縁取り寬度後有些對不上）。
   id 不改：シーン連動 的規則存的是 id。 */
export const PRESETS = [
  { id: 'default',   name: 'デフォルト',
    src: line('#FFFFFF', '#000000'), t1: line('#FFFFFF', '#000000'), t2: line('#FFFFFF', '#000000'), t3: line('#FFFFFF', '#000000') },
  { id: 'standard',  name: 'カラフル',
    src: line('#FFFFFF', '#000000'), t1: line('#FFE873', '#000000'), t2: line('#9FD4FF', '#000000'), t3: line('#FFB3C7', '#000000') },
  /* 原文はおばけの白、かぼちゃのオレンジ・魔女の紫・ろうそくの黄色に、夜の黒紫の縁取り。
     ハロウィン定番の黄緑はクロマキーで抜けるので使わない。 */
  { id: 'halloween', name: 'ハロウィン',
    src: line('#FFF4E0', '#1A0B24'), t1: line('#FF7A00', '#1A0B24'), t2: line('#B86BFF', '#1A0B24'), t3: line('#FFD23F', '#1A0B24') },
  { id: 'cute',      name: 'ピンク',
    src: line('#FFFFFF', '#5A1E3C'), t1: line('#FF8FB1', '#5A1E3C'), t2: line('#B79CFF', '#5A1E3C'), t3: line('#FFD27F', '#5A1E3C') },
  /* 原文は雪の白、金の飾り・ヒイラギの赤・氷の水色に、深いワインレッドの縁取り。
     クリスマスの緑は暗い色でもクロマキーにかかりやすいので使わない。 */
  { id: 'christmas', name: 'クリスマス',
    src: line('#FFFFFF', '#3A0A12'), t1: line('#FFD24A', '#3A0A12'), t2: line('#FF5A5F', '#3A0A12'), t3: line('#BFE3FF', '#3A0A12') },
  { id: 'imp',       name: 'ラベンダー',
    src: line('#FFFFFF', '#241A2E'), t1: line('#CDA8FF', '#241A2E'), t2: line('#FF7EB9', '#241A2E'), t3: line('#9FB8FF', '#241A2E') },
  { id: 'berrymilk', name: 'いちごミルク',
    src: line('#FFFFFF', '#C8336F'), t1: line('#FFC2DA', '#A82A5E'), t2: line('#FFF1A8', '#A82A5E'), t3: line('#FFE0EC', '#A82A5E') },
  { id: 'contrast',  name: 'ビビッド',
    src: line('#FFFFFF', '#000000'), t1: line('#FFFF00', '#000000'), t2: line('#7FDBFF', '#000000'), t3: line('#FFB0E0', '#000000') },
  { id: 'retro',     name: 'レトロ',
    src: line('#F3E6C8', '#3B2414'), t1: line('#F2B45A', '#3B2414'), t2: line('#E89A7C', '#3B2414'), t3: line('#D9C27A', '#3B2414') },
  /* 這個配信者料理配信時用的配色：白い縁取りに、行ごとに濃い色（原文は紫がかった墨色、紫・赤・青）。 */
  { id: 'cooking',   name: '料理配信',
    src: line('#4B3B63', '#FFFFFF'), t1: line('#8A2BE2', '#FFFFFF'), t2: line('#E0201E', '#FFFFFF'), t3: line('#2457D6', '#FFFFFF') },
  /* 同じく歌枠用：料理配信とは逆で、文字は白、縁取りが行ごとの色（原文はラベンダー、紫・えんじ・ピンク）。
     白い字が埋もれないよう、縁取りは画面で見た色より少し濃くしてある。 */
  { id: 'singing',   name: '歌枠配信',
    src: line('#FFFFFF', '#8F88E0'), t1: line('#FFFFFF', '#8E2CC2'), t2: line('#FFFFFF', '#84182A'), t3: line('#FFFFFF', '#E04493') },
];

/** マイテーマ 的設定 key。OBS連携 的視窗監聽它，存了新的就重畫場景清單。 */
export const CUSTOM_THEMES_KEY = 'subtitle-custom-themes';

/** マイテーマ 三格的 id 與名稱（シーン連動 的選單用 name，主題選單裡用 short）。 */
export const CUSTOM_SLOTS = [1, 2, 3].map(n => ({ id: `custom${n}`, name: `マイテーマ ${n}`, short: `マイ ${n}` }));

const isHex = (value) => /^#[0-9A-F]{6}$/.test(value);

/** 存下來的三格，空的或壞掉的格子是 null。 */
function loadCustomThemes() {
  let saved = [];
  try {
    const parsed = JSON.parse(getSetting(CUSTOM_THEMES_KEY));
    if (Array.isArray(parsed)) saved = parsed;
  } catch { /* 壞掉的值當作全部空著 */ }
  return CUSTOM_SLOTS.map((slot, index) => {
    const theme = saved[index];
    const valid = theme && LINES.every(([, key]) => isHex(theme[key]?.color) && isHex(theme[key]?.stroke));
    return valid ? { ...theme, id: slot.id, name: slot.name } : null;
  });
}

/* id 與名稱由格子的位置決定，只存四行的顏色。 */
function saveCustomTheme(index, theme) {
  const themes = loadCustomThemes();
  themes[index] = theme;
  const colours = themes.map(t => t && Object.fromEntries(LINES.map(([, key]) => [key, t[key]])));
  setSetting(CUSTOM_THEMES_KEY, JSON.stringify(colours));
}

/** 這個 id 的主題（內建或マイテーマ）。沒有這個 id、或那格還空著時是 undefined。 */
function findTheme(id) {
  const custom = CUSTOM_SLOTS.findIndex(slot => slot.id === id);
  if (custom >= 0) return loadCustomThemes()[custom] || undefined;
  return PRESETS.find(p => p.id === id);
}

/** シーン連動 的選單用：這格マイテーマ是否存過。 */
export function hasCustomTheme(id) {
  return CUSTOM_SLOTS.some(slot => slot.id === id) && !!findTheme(id);
}

/** 套用之後要做的事（主視窗：馬上推給 OBS 的 overlay）。由 mountSubtitlePresets() 設定。 */
let afterApply = () => {};
/** 選單的打勾狀態。由 mountSubtitlePresets() 設定。 */
let syncMenu = () => {};

const inputsOf = (prefix) => ({
  color: document.getElementById(`${prefix}-font-color`),
  stroke: document.getElementById(`${prefix}-font-stroke-color`)
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
  }
  syncMenu();
  afterApply();
}

/* 設定畫面上現在的顏色。input[type="color"] 的 value 一律是小寫，這裡統一成大寫。 */
function currentColours() {
  return Object.fromEntries(LINES.map(([prefix, slot]) => {
    const inputs = inputsOf(prefix);
    return [slot, line(inputs.color?.value.toUpperCase() || '#FFFFFF', inputs.stroke?.value.toUpperCase() || '#000000')];
  }));
}

function matches(preset) {
  const now = currentColours();
  return LINES.every(([, slot]) => now[slot].color === preset[slot].color && now[slot].stroke === preset[slot].stroke);
}

/**
 * 依 id 套用主題（主視窗：シーン連動 切換場景時）。マイテーマ 的 id 也可以。
 * @returns {boolean} 沒有這個 id（規則存下之後主題被拿掉了）、或那格マイテーマ還空著時
 *   回傳 false，什麼都不改
 */
export function applyPreset(id) {
  const preset = findTheme(id);
  if (preset) apply(preset);
  return !!preset;
}

/* 每一項用自己配色的翻訳 1 畫出名稱（原文大多是白色），再加四個點表示四行：
   點是文字色、外圈是縁取り色（歌枠配信這種文字全白的，靠外圈才分得出來）。選單本身就是預覽。
   マイテーマ 存了新的顏色時重畫同一顆按鈕，所以「畫」和「建立」分開。 */
function createItem(id) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'subtitle-preset-item';
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', 'false');
  item.dataset.preset = id;
  return item;
}

function paintItem(item, preset, label) {
  const name = document.createElement('span');
  name.className = 'subtitle-preset-name';
  name.textContent = preset ? label : `${label}（空き）`;

  const dots = document.createElement('span');
  dots.className = 'subtitle-preset-dots';
  dots.setAttribute('aria-hidden', 'true');

  item.disabled = !preset;
  item.classList.toggle('is-empty', !preset);
  if (preset) {
    item.style.setProperty('--p-color', preset.t1.color);
    item.style.setProperty('--p-stroke', preset.t1.stroke);
    for (const [, slot] of LINES) {
      const dot = document.createElement('i');
      dot.style.background = preset[slot].color;
      dot.style.setProperty('--dot-stroke', preset[slot].stroke);
      dots.append(dot);
    }
  } else {
    item.style.removeProperty('--p-color');
    item.style.removeProperty('--p-stroke');
  }
  item.replaceChildren(name, dots);
}

function createHead(text) {
  const head = document.createElement('span');
  head.className = 'subtitle-preset-head';
  head.textContent = text;
  return head;
}

/**
 * 主視窗：在 #subtitle-preset-menu 裡畫出主題選單並接上。
 * @param {{ onApplied?: () => void }} [options] onApplied：套用主題之後呼叫
 * @returns {{ sync: () => void }} sync：設定被程式改掉（全部重設）之後，重新對打勾
 */
export function mountSubtitlePresets({ onApplied = () => {} } = {}) {
  afterApply = onApplied;
  const menu = document.getElementById('subtitle-preset-menu');
  if (!menu) return { sync() {} };

  const grid = document.createElement('div');
  grid.className = 'subtitle-preset-grid';
  const items = PRESETS.map(preset => {
    const item = createItem(preset.id);
    paintItem(item, preset, preset.name);
    return item;
  });
  grid.append(...items);

  /* マイテーマ：每格是套用的按鈕加一顆「保存」。保存後選單不關，存進去的顏色馬上看得到。 */
  const mine = document.createElement('div');
  mine.className = 'subtitle-preset-grid subtitle-preset-mine';
  const slotItems = CUSTOM_SLOTS.map((slot, index) => {
    const item = createItem(slot.id);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'subtitle-preset-save';
    save.textContent = '保存';
    save.title = `いまの文字色・縁取り色を「${slot.name}」に保存します（前の内容は上書きされます）`;
    save.addEventListener('click', () => {
      saveCustomTheme(index, currentColours());
      repaintSlots();
      syncMenu();
    });
    const cell = document.createElement('div');
    cell.className = 'subtitle-preset-slot';
    cell.append(item, save);
    mine.append(cell);
    return item;
  });

  function repaintSlots() {
    const themes = loadCustomThemes();
    slotItems.forEach((item, index) => paintItem(item, themes[index], CUSTOM_SLOTS[index].short));
  }
  repaintSlots();

  menu.append(createHead('字幕テーマ'), grid, createHead('マイテーマ（「保存」でいまの色を記録）'), mine);

  const allItems = [...items, ...slotItems];
  syncMenu = () => {
    for (const item of allItems) {
      const preset = findTheme(item.dataset.preset);
      item.setAttribute('aria-checked', String(!!preset && matches(preset)));
    }
  };

  for (const item of allItems) {
    item.addEventListener('click', () => {
      if (!applyPreset(item.dataset.preset)) return;
      menu.hidePopover();
    });
  }

  /* 手動改了顏色，打勾就跟著變。 */
  for (const [prefix] of LINES) {
    for (const el of Object.values(inputsOf(prefix))) el?.addEventListener('input', () => syncMenu());
  }

  syncMenu();
  return { sync: () => syncMenu() };
}
