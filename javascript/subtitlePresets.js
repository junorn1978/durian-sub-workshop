/**
 * @file subtitlePresets.js
 * @description 字幕テーマ：一次換掉四行字幕的配色。
 *              從姊妹專案（即時翻譯 v1.32.0〜v1.35.0）移植，那邊只有三行，翻訳 3 是這邊補的。
 *
 * 配色只是資料，不是 CSS。套用時把值寫進設定畫面的 input，再派送 'input'（縁取りの種類 是 'change'）事件，
 * 存檔、CSS 變數、色塊按鈕、雲的 filter 全都照手動改的路走（見 settingsBindings.js、colorPicker.js、
 * uiController.js），所以下游不需要知道有配色這回事。也因此沒有「目前的配色」這個設定：
 * 目前的值剛好和哪一組一樣，就是哪一組；之後手動改了，自然就哪組都不是。
 *
 * 【縁取りの種類】一般的縁取り（stroke）與雲（bubble／gooey，見 subtitleCloud.js）各有一套主題，
 * 選單只列出目前種類的那一套——一般縁取り的配色做成雲多半不好看，反之亦然。
 * 兩種的值也分開存（*-font-* 與 *-cloud-*），所以套用雲的主題不會動到一般縁取り的設定，
 * 切回一般縁取り時就是上次自己調的樣子。這點和姊妹專案不同：那邊文字色與縁取り色是兩種共用的。
 *
 * 一般縁取り的主題只換顏色，刻意不動：
 *  - 文字サイズ、縁取りサイズ：看解析度、版面和個人習慣，不是看風格。
 *    姊妹專案的配色連縁取り寬度一起換，這邊拿掉了——換主題時大小不該跟著跳。
 * 雲的主題則照姊妹專案，連雲的大小與外枠寬一起換：雲的外觀大半靠這兩個值，
 * 而且它們存在雲自己那一組，不會影響一般縁取り。文字サイズ 兩種都不動。
 * 背景色兩種都不動：ウィンドウキャプチャ時是クロマキー的顏色，動了會抜けなくなる。
 *
 * 不用偏綠的顏色：背景預設是 #00FF00，類似度調高時薄荷綠、草綠會被一起抜掉。
 *
 * 名稱刻意用一般詞。有些配色參考了知名角色的配色，但不寫出角色名稱與商標。
 *
 * 【マイテーマ】另外有三格讓使用者存自己目前的配色。存的是存檔當下那個縁取りの種類 的值
 * （一般縁取り：文字色與縁取り色；雲：再加上外枠色、雲的大小與外枠寬，以及是哪一種雲），
 * 兩種種類下都列出來，套用時順便切到那格的種類。
 * 存在 'subtitle-custom-themes'，和字幕外觀一樣每個視窗各一份。
 * シーン連動 也能選這三格；選了空的格子，切場景時就維持原本的顏色。
 * 「全部重設」不清這三格：和翻訳クラウド接続 的 URL 一樣，是使用者自己做出來的東西。
 *
 * 這個模組最上層不碰 DOM：OBS連携 的視窗只拿 PRESETS／CUSTOM_SLOTS 來列選單（見 obsSceneLink.js）。
 */

import { getSetting, setSetting } from './settingsStore.js';
import { isCloudOutline, SUBTITLE_OUTLINE_EVENT } from './subtitleCloud.js';

/* 每一行字幕的 input id 前綴，與配色裡的欄位。 */
const LINES = [['source', 'src'], ['target1', 't1'], ['target2', 't2'], ['target3', 't3']];

const line = (color, stroke) => ({ color, stroke });
/* 雲的一行：stroke 是雲的顏色、w 是雲的大小（0〜15）、rim 是外枠色。外枠寬 rimW 是整組共用的。 */
const cloud = (color, stroke, w, rim) => ({ color, stroke, w, rim });

/** 縁取りの種類 的名稱（主題選單、シーン連動 的選單分組用）。 */
export const OUTLINE_NAMES = { stroke: '縁取り', bubble: 'バブル', gooey: 'もこもこ' };

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
  /* 紅包・お年玉袋の朱赤の縁取りに、原文は白、金・シャンパンゴールド・梅の花の薄紅。
     お正月（1月1日）にも旧正月（春節）にも使えるよう、名前は「新年」にした。 */
  { id: 'newyear',   name: '新年',
    src: line('#FFFFFF', '#A80F1A'), t1: line('#FFD54A', '#A80F1A'), t2: line('#FFE9B0', '#A80F1A'), t3: line('#FFC2C2', '#A80F1A') },
  /* 這個配信者料理配信時用的配色：白い縁取りに、行ごとに濃い色（原文は紫がかった墨色、紫・赤・青）。 */
  { id: 'cooking',   name: '料理配信',
    src: line('#4B3B63', '#FFFFFF'), t1: line('#8A2BE2', '#FFFFFF'), t2: line('#E0201E', '#FFFFFF'), t3: line('#2457D6', '#FFFFFF') },
  /* 同じく歌枠用：料理配信とは逆で、文字は白、縁取りが行ごとの色（原文はラベンダー、紫・えんじ・ピンク）。
     白い字が埋もれないよう、縁取りは画面で見た色より少し濃くしてある。 */
  { id: 'singing',   name: '歌枠配信',
    src: line('#FFFFFF', '#8F88E0'), t1: line('#FFFFFF', '#8E2CC2'), t2: line('#FFFFFF', '#84182A'), t3: line('#FFFFFF', '#E04493') },

  /* ここから雲の縁取りのテーマ（姊妹專案 v1.35.0 のまま。翻訳 3 はこちらで足した）。
     id の頭に種類を付けるのは姊妹專案と同じで、一般のテーマと id がぶつからない。 */
  { id: 'bubbleSticker',  name: 'ステッカー', outline: 'bubble', rimW: 4,
    src: cloud('#FF4FA3', '#FFFFFF', 1, '#FA5151'), t1: cloud('#38BDF8', '#FFFFFF', 1, '#28C1DF'),
    t2: cloud('#CD9AFD', '#FFFFFF', 1, '#CD9AFD'), t3: cloud('#FF9F1C', '#FFFFFF', 1, '#FF9F1C') },
  { id: 'bubbleLavender', name: 'ラベンダー', outline: 'bubble', rimW: 7,
    src: cloud('#1A1A1A', '#C1B6FF', 11, '#C8337A'), t1: cloud('#1A1A1A', '#B4CBFF', 11, '#C8337A'),
    t2: cloud('#1A1A1A', '#F2A7C9', 11, '#C8337A'), t3: cloud('#1A1A1A', '#FFD3A8', 11, '#C8337A') },
  { id: 'bubbleCandy',    name: 'キャンディ', outline: 'bubble', rimW: 3,
    src: cloud('#FFFFFF', '#FF7FB0', 6, '#FFFFFF'), t1: cloud('#FFFFFF', '#B58CFF', 6, '#FFFFFF'),
    t2: cloud('#FFFFFF', '#FF9E6B', 6, '#FFFFFF'), t3: cloud('#FFFFFF', '#6EB6FF', 6, '#FFFFFF') },
  { id: 'bubbleSoda',     name: 'ソーダ', outline: 'bubble', rimW: 8,
    src: cloud('#0B2545', '#8FD3FF', 6, '#FFFFFF'), t1: cloud('#0B2545', '#BFE6FF', 6, '#FFFFFF'),
    t2: cloud('#0B2545', '#FFD6E8', 6, '#FFFFFF'), t3: cloud('#0B2545', '#E3D4FF', 6, '#FFFFFF') },
  { id: 'bubbleLemon',    name: 'レモン', outline: 'bubble', rimW: 6,
    src: cloud('#3B2414', '#FFE27A', 6, '#E07A2E'), t1: cloud('#3B2414', '#FFF3B0', 6, '#E07A2E'),
    t2: cloud('#3B2414', '#FFC9A3', 6, '#E07A2E'), t3: cloud('#3B2414', '#FFD8E4', 6, '#E07A2E') },
  { id: 'bubbleNight',    name: '夜空', outline: 'bubble', rimW: 4,
    src: cloud('#FFFFFF', '#2A2350', 6, '#B79CFF'), t1: cloud('#FFE873', '#2A2350', 6, '#B79CFF'),
    t2: cloud('#9FD4FF', '#2A2350', 6, '#B79CFF'), t3: cloud('#FF9EC8', '#2A2350', 6, '#B79CFF') },

  { id: 'gooeyPeach', name: 'ピーチ', outline: 'gooey', rimW: 8,
    src: cloud('#4A1F12', '#FFB38A', 6, '#FFFFFF'), t1: cloud('#4A1F12', '#FFD0A8', 6, '#FFFFFF'),
    t2: cloud('#4A1F12', '#FFC2D4', 6, '#FFFFFF'), t3: cloud('#4A1F12', '#FFE0A3', 6, '#FFFFFF') },
  { id: 'gooeyGrape', name: 'グレープ', outline: 'gooey', rimW: 6,
    src: cloud('#FFFFFF', '#7B4FC9', 6, '#F5D0FF'), t1: cloud('#FFFFFF', '#9A6BE0', 6, '#F5D0FF'),
    t2: cloud('#FFFFFF', '#C25AA8', 6, '#F5D0FF'), t3: cloud('#FFFFFF', '#5A5FD0', 6, '#F5D0FF') },
  { id: 'gooeyInk',   name: '墨', outline: 'gooey', rimW: 8,
    src: cloud('#FFFFFF', '#1C1C24', 4, '#FFD400'), t1: cloud('#FFE873', '#1C1C24', 4, '#FFD400'),
    t2: cloud('#9FD4FF', '#1C1C24', 4, '#FFD400'), t3: cloud('#FF9EC8', '#1C1C24', 4, '#FFD400') },
];

/** 主題的縁取りの種類。沒有 outline 的（一般縁取り的主題、雲出現以前存的マイテーマ）是 'stroke'。 */
export const outlineOf = (preset) => isCloudOutline(preset?.outline) ? preset.outline : 'stroke';

const isCloud = (preset) => outlineOf(preset) !== 'stroke';

/** マイテーマ 的設定 key。OBS連携 的視窗監聽它，存了新的就重畫場景清單。 */
export const CUSTOM_THEMES_KEY = 'subtitle-custom-themes';

/** マイテーマ 三格的 id 與名稱（シーン連動 的選單用 name，主題選單裡用 short）。 */
export const CUSTOM_SLOTS = [1, 2, 3].map(n => ({ id: `custom${n}`, name: `マイテーマ ${n}`, short: `マイ ${n}` }));

const isHex = (value) => /^#[0-9A-F]{6}$/.test(value);

/* 一格存的內容是否完整。雲的格子還要有外枠色、雲的大小與外枠寬。 */
function isValidTheme(theme) {
  if (!theme) return false;
  const cloudTheme = isCloud(theme);
  return LINES.every(([, key]) => isHex(theme[key]?.color) && isHex(theme[key]?.stroke)
      && (!cloudTheme || (isHex(theme[key]?.rim) && Number.isFinite(theme[key]?.w))))
    && (!cloudTheme || Number.isFinite(theme.rimW));
}

/** 存下來的三格，空的或壞掉的格子是 null。 */
function loadCustomThemes() {
  let saved = [];
  try {
    const parsed = JSON.parse(getSetting(CUSTOM_THEMES_KEY));
    if (Array.isArray(parsed)) saved = parsed;
  } catch { /* 壞掉的值當作全部空著 */ }
  return CUSTOM_SLOTS.map((slot, index) => {
    const theme = saved[index];
    return isValidTheme(theme) ? { ...theme, id: slot.id, name: slot.name } : null;
  });
}

/* id 與名稱由格子的位置決定，不存。 */
function saveCustomTheme(index, theme) {
  const themes = loadCustomThemes();
  themes[index] = theme;
  const stored = themes.map((saved) => {
    if (!saved) return null;
    const { id, name, ...rest } = saved;
    return rest;
  });
  setSetting(CUSTOM_THEMES_KEY, JSON.stringify(stored));
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

/* 一行在某個種類下的 input。一般縁取り與雲是不同的 input（各自存檔）。 */
const inputsOf = (prefix, cloudMode) => {
  const el = (suffix) => document.getElementById(`${prefix}-${suffix}`);
  return cloudMode
    ? { color: el('cloud-text-color'), stroke: el('cloud-color'), rim: el('cloud-rim-color'), w: el('cloud-size') }
    : { color: el('font-color'), stroke: el('font-stroke-color') };
};
const rimWidthInput = () => document.getElementById('cloud-rim-width-opt');
const outlineRadios = () => [...document.querySelectorAll('input[name="subtitle-outline"]')];

/** 目前的縁取りの種類（設定畫面的單選鈕）。 */
function currentOutline() {
  return outlineOf({ outline: outlineRadios().find(r => r.checked)?.value });
}

/* 寫進 input 並派送事件，讓設定綁定與色塊按鈕照手動操作的路處理。 */
function setInput(el, value) {
  if (!el) return;
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* 切換縁取りの種類：和手動點單選鈕一樣派送 'change'。已經是那個種類就不動。 */
function setOutline(outline) {
  const radio = outlineRadios().find(r => r.value === outline);
  if (!radio || radio.checked) return;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

/* 先切種類、再寫那個種類的 input。另一個種類的值不碰。 */
function apply(preset) {
  const cloudTheme = isCloud(preset);
  setOutline(outlineOf(preset));
  if (cloudTheme) setInput(rimWidthInput(), preset.rimW);
  for (const [prefix, slot] of LINES) {
    const inputs = inputsOf(prefix, cloudTheme);
    setInput(inputs.color, preset[slot].color);
    setInput(inputs.stroke, preset[slot].stroke);
    if (cloudTheme) {
      setInput(inputs.rim, preset[slot].rim);
      setInput(inputs.w, preset[slot].w);
    }
  }
  syncMenu();
  afterApply();
}

/* 設定畫面上目前種類的值，做成主題的形狀。input[type="color"] 的 value 一律是小寫，這裡統一成大寫。
   一般縁取り不帶 outline，和雲出現以前存的マイテーマ同一個形狀。 */
function currentTheme() {
  const outline = currentOutline();
  const cloudMode = outline !== 'stroke';
  const lines = Object.fromEntries(LINES.map(([prefix, slot]) => {
    const inputs = inputsOf(prefix, cloudMode);
    const color = inputs.color?.value.toUpperCase() || '#FFFFFF';
    const stroke = inputs.stroke?.value.toUpperCase() || '#000000';
    return [slot, cloudMode
      ? cloud(color, stroke, Number(inputs.w?.value), inputs.rim?.value.toUpperCase() || '#FFFFFF')
      : line(color, stroke)];
  }));
  return cloudMode ? { outline, rimW: Number(rimWidthInput()?.value), ...lines } : lines;
}

function matches(preset) {
  const now = currentTheme();
  if (outlineOf(now) !== outlineOf(preset)) return false;
  const cloudTheme = isCloud(preset);
  if (cloudTheme && now.rimW !== preset.rimW) return false;
  return LINES.every(([, slot]) => now[slot].color === preset[slot].color && now[slot].stroke === preset[slot].stroke
    && (!cloudTheme || (now[slot].rim === preset[slot].rim && now[slot].w === preset[slot].w)));
}

/**
 * 依 id 套用主題（主視窗：シーン連動 切換場景時）。マイテーマ 的 id 也可以。
 * 雲的主題會順便切到那個種類。
 * @returns {boolean} 沒有這個 id（規則存下之後主題被拿掉了）、或那格マイテーマ還空著時
 *   回傳 false，什麼都不改
 */
export function applyPreset(id) {
  const preset = findTheme(id);
  if (preset) apply(preset);
  return !!preset;
}

/* 每一項用自己配色的翻訳 1 畫出名稱（原文大多是白色），再加四個點表示四行：
   點是文字色、外圈是縁取り色（歌枠配信這種文字全白的，靠外圈才分得出來）。
   雲的主題外圈是雲的顏色，再多一圈外枠色——マイテーマ 裡也靠這個分出是雲的格子。選單本身就是預覽。
   マイテーマ 存了新的配色時重畫同一顆按鈕，所以「畫」和「建立」分開。 */
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
  item.classList.toggle('is-cloud', !!preset && isCloud(preset));
  /* 雲的マイテーマ 在一般縁取り下也列出來，用 title 說明套用後會切到哪一種。 */
  item.title = preset && isCloud(preset) ? `${OUTLINE_NAMES[outlineOf(preset)]}のテーマ` : '';
  if (preset) {
    item.style.setProperty('--p-color', preset.t1.color);
    item.style.setProperty('--p-stroke', preset.t1.stroke);
    for (const [, slot] of LINES) {
      const dot = document.createElement('i');
      dot.style.background = preset[slot].color;
      dot.style.setProperty('--dot-stroke', preset[slot].stroke);
      if (preset[slot].rim) dot.style.setProperty('--dot-rim', preset[slot].rim);
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
 * 主視窗：在 #subtitle-preset-menu 裡（縁取りの種類 的切換之下）畫出主題選單並接上。
 * @param {{ onApplied?: () => void }} [options] onApplied：套用主題之後呼叫
 * @returns {{ sync: () => void }} sync：設定被程式改掉（全部重設）之後，重新對打勾
 */
export function mountSubtitlePresets({ onApplied = () => {} } = {}) {
  afterApply = onApplied;
  const menu = document.getElementById('subtitle-preset-menu');
  if (!menu) return { sync() {} };

  const grid = document.createElement('div');
  grid.className = 'subtitle-preset-grid';
  grid.setAttribute('role', 'menu');
  grid.setAttribute('aria-label', '字幕テーマ');
  const items = PRESETS.map(preset => {
    const item = createItem(preset.id);
    paintItem(item, preset, preset.name);
    return item;
  });
  grid.append(...items);

  /* マイテーマ：每格是套用的按鈕加一顆「保存」。保存後選單不關，存進去的配色馬上看得到。 */
  const mine = document.createElement('div');
  mine.className = 'subtitle-preset-grid subtitle-preset-mine';
  mine.setAttribute('role', 'menu');
  mine.setAttribute('aria-label', 'マイテーマ');
  const slotItems = CUSTOM_SLOTS.map((slot, index) => {
    const item = createItem(slot.id);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'subtitle-preset-save';
    save.textContent = '保存';
    save.title = `いまの配色（縁取りの種類を含む）を「${slot.name}」に保存します（前の内容は上書きされます）`;
    save.addEventListener('click', () => {
      saveCustomTheme(index, currentTheme());
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

  const head = createHead('');
  menu.append(head, grid, createHead('マイテーマ（「保存」でいまの配色を記録）'), mine);

  /* 內建主題只列出目前種類的；マイテーマ 兩種都列（哪一種都可能存）。 */
  const filterByOutline = () => {
    const outline = currentOutline();
    head.textContent = `字幕テーマ（${OUTLINE_NAMES[outline]}）`;
    for (const item of items) item.hidden = outlineOf(findTheme(item.dataset.preset)) !== outline;
  };

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

  /* 手動改了配色或縁取りの種類，打勾就跟著變。 */
  const watched = [rimWidthInput(), ...LINES.flatMap(([prefix]) =>
    [...Object.values(inputsOf(prefix, false)), ...Object.values(inputsOf(prefix, true))])];
  for (const el of watched) el?.addEventListener('input', () => syncMenu());
  document.addEventListener(SUBTITLE_OUTLINE_EVENT, () => {
    filterByOutline();
    syncMenu();
  });

  filterByOutline();
  syncMenu();
  return { sync: () => { filterByOutline(); syncMenu(); } };
}
