/**
 * @file colorPicker.js
 * @description 可重複使用的自訂調色盤，讓完整選色與快捷色顯示在同一個浮動面板。
 *
 * 原生的色彩對話框是獨立的 OS 視窗，一來無法套用樣式（直播時在深色面板上
 * 跳出一個亮色系統視窗），二來它在頁面之外，做視窗擷取時會拍到奇怪的狀態。
 * 這個面板一律留在頁面內。
 *
 * input[type="color"] 本身留在 DOM 裡當作值的載體，settingsBindings.js 的設定
 * 綁定就是掛在它上面。本模組只負責隱藏與驅動：每次變更都寫回 input 並派送
 * 一個會冒泡的 'input' 事件，因此上層完全不需要知道有這個面板存在。
 *
 * 【markup contract】觸發按鈕寫在 HTML 裡，不由 JS 注入——按鈕是版面
 * （.control-group / .settings-row）的 flex 項目，注入會打亂排版：
 *
 *   <span class="color-cell">
 *     <input type="color" class="native-color-input" id="…" list="…" title="…">
 *     <button type="button" class="color-picker-trigger" data-color-trigger …></button>
 *   </span>
 *
 * 按鈕在自己的父元素裡找對應的 input；快捷色來自該 input 的 list 所指的
 * <datalist>。背景色那顆改用 .color-picker-trigger-text，顯示文字而不是色塊
 * （頁面背景本來就一直看得到，再放一個色塊是重複的）。
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeHex = (value) => {
  const raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map(char => char + char).join('')}`.toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toUpperCase()}` : null;
};

const hexToHsv = (hex) => {
  const normalized = normalizeHex(hex) || '#FFFFFF';
  const red = parseInt(normalized.slice(1, 3), 16) / 255;
  const green = parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  return {
    h: hue < 0 ? hue + 360 : hue,
    s: max === 0 ? 0 : delta / max,
    v: max
  };
};

const hsvToHex = ({ h, s, v }) => {
  const chroma = v * s;
  const sector = h / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = v - chroma;
  let rgb;

  if (sector < 1) rgb = [chroma, x, 0];
  else if (sector < 2) rgb = [x, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, x];
  else if (sector < 4) rgb = [0, x, chroma];
  else if (sector < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  return `#${rgb.map(channel => Math.round((channel + match) * 255)
    .toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};

const createElement = (tag, className, attributes = {}) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
};

/**
 * 將頁面上的 input[type="color"] 升級為自訂調色盤。
 * @returns {{ sync: Function, close: Function }}
 */
export const setupColorPickers = () => {
  /* markup contract（見檔頭）：按鈕已經寫在 HTML 裡，成對的 input 就在同一個父元素中。 */
  const pairs = [...document.querySelectorAll('[data-color-trigger]')]
    .map(trigger => ({ trigger, input: trigger.parentElement?.querySelector('input[type="color"]') }))
    .filter(pair => pair.input);
  if (!pairs.length) return { sync() {}, close() {} };

  const popover = createElement('div', 'color-picker-popover', {
    role: 'dialog',
    'aria-label': 'カラーパレット',
    'aria-hidden': 'true'
  });
  const header = createElement('div', 'color-picker-header');
  header.textContent = 'カラーパレット';

  const saturation = createElement('div', 'color-picker-saturation', {
    role: 'slider', tabindex: '0',
    'aria-label': '彩度と明るさ',
    'aria-valuemin': '0', 'aria-valuemax': '100'
  });
  const saturationCursor = createElement('span', 'color-picker-saturation-cursor');
  saturation.append(saturationCursor);

  const hueLabel = createElement('label', 'color-picker-field-label');
  hueLabel.textContent = '色相';
  const hue = createElement('input', 'color-picker-hue', {
    type: 'range', min: '0', max: '359', step: '1', 'aria-label': '色相'
  });
  hueLabel.append(hue);

  const valueRow = createElement('div', 'color-picker-value-row');
  const preview = createElement('span', 'color-picker-preview', { 'aria-hidden': 'true' });
  const hexLabel = createElement('label', 'color-picker-hex-label');
  hexLabel.textContent = 'カラーコード';
  const hexInput = createElement('input', 'color-picker-hex', {
    type: 'text', maxlength: '7', spellcheck: 'false', 'aria-label': 'カラーコード'
  });
  hexLabel.append(hexInput);
  valueRow.append(preview, hexLabel);

  const presetLabel = createElement('div', 'color-picker-presets-label');
  presetLabel.textContent = 'クイックカラー';
  const presets = createElement('div', 'color-picker-presets');
  popover.append(header, saturation, hueLabel, valueRow, presetLabel, presets);
  document.body.append(popover);

  let activeInput = null;
  let activeTrigger = null;
  let hsv = { h: 0, s: 0, v: 1 };

  /** input → 対応するトリガー。markup contract で決まる対応関係をここに持つ。 */
  const triggerOf = new WeakMap();

  const syncTrigger = (input) => {
    const trigger = triggerOf.get(input);
    if (!trigger) return;
    const color = normalizeHex(input.value) || '#FFFFFF';
    trigger.style.setProperty('--selected-color', color);
    const label = `${input.title || 'カラー'}: ${color}`;
    // テキストボタンは表示文言がそのままアクセシブル名になるので、
    // aria-label で上書きせず現在の色は title にのせる。
    if (trigger.classList.contains('color-picker-trigger-text')) trigger.title = label;
    else trigger.setAttribute('aria-label', label);
  };

  const render = () => {
    const color = hsvToHex(hsv);
    saturation.style.setProperty('--picker-hue', `hsl(${hsv.h}, 100%, 50%)`);
    saturationCursor.style.left = `${hsv.s * 100}%`;
    saturationCursor.style.top = `${(1 - hsv.v) * 100}%`;
    saturation.setAttribute('aria-valuenow', String(Math.round(hsv.s * 100)));
    saturation.setAttribute('aria-valuetext', `彩度 ${Math.round(hsv.s * 100)}%、明るさ ${Math.round(hsv.v * 100)}%`);
    hue.value = String(Math.round(hsv.h));
    preview.style.backgroundColor = color;
    hexInput.value = color;
    presets.querySelectorAll('.color-picker-preset').forEach(swatch => {
      swatch.classList.toggle('is-selected', normalizeHex(swatch.title) === color);
    });
  };

  const apply = ({ dispatch = true } = {}) => {
    if (!activeInput) return;
    const color = hsvToHex(hsv);
    activeInput.value = color;
    syncTrigger(activeInput);
    render();
    if (dispatch) activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const setColor = (color, dispatch = true) => {
    const normalized = normalizeHex(color);
    if (!normalized) return false;
    hsv = hexToHsv(normalized);
    apply({ dispatch });
    return true;
  };

  const renderPresets = () => {
    presets.replaceChildren();
    const options = activeInput?.list ? [...activeInput.list.options] : [];
    options.forEach(option => {
      const color = normalizeHex(option.value);
      if (!color) return;
      const swatch = createElement('button', 'color-picker-preset', {
        type: 'button', title: color, 'aria-label': color
      });
      swatch.style.setProperty('--preset-color', color);
      swatch.addEventListener('click', () => setColor(color));
      presets.append(swatch);
    });
    presetLabel.hidden = options.length === 0;
    presets.hidden = options.length === 0;
  };

  const positionPopover = () => {
    if (!activeTrigger) return;
    const rect = activeTrigger.getBoundingClientRect();
    const gap = 8;
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = clamp(rect.left + rect.width / 2 - width / 2, gap, window.innerWidth - width - gap);
    const below = rect.bottom + gap;
    const opensBelow = below + height <= window.innerHeight - gap;
    const top = opensBelow ? below : Math.max(gap, rect.top - height - gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    // 入場アニメーションがトリガー（色ボタン）側から展開するように原点を合わせる
    const originX = clamp(rect.left + rect.width / 2 - left, 0, width);
    popover.style.transformOrigin = `${originX}px ${opensBelow ? '0px' : '100%'}`;
  };

  const close = ({ restoreFocus = false } = {}) => {
    if (!activeInput) return;
    const previousTrigger = activeTrigger;
    activeTrigger?.setAttribute('aria-expanded', 'false');
    popover.classList.remove('is-open');
    popover.setAttribute('aria-hidden', 'true');
    activeInput = null;
    activeTrigger = null;
    if (restoreFocus) previousTrigger?.focus();
  };

  const open = (input, trigger) => {
    if (activeInput === input) {
      close();
      return;
    }
    activeTrigger?.setAttribute('aria-expanded', 'false');
    activeInput = input;
    activeTrigger = trigger;
    hsv = hexToHsv(input.value);
    renderPresets();
    render();
    trigger.setAttribute('aria-expanded', 'true');
    popover.classList.add('is-open');
    popover.setAttribute('aria-hidden', 'false');
    positionPopover();
  };

  const updateSaturation = (event) => {
    const rect = saturation.getBoundingClientRect();
    hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    apply();
  };

  saturation.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    saturation.setPointerCapture(event.pointerId);
    updateSaturation(event);
  });
  saturation.addEventListener('pointermove', (event) => {
    if (saturation.hasPointerCapture(event.pointerId)) updateSaturation(event);
  });
  saturation.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    if (event.key === 'ArrowLeft') hsv.s = clamp(hsv.s - step, 0, 1);
    else if (event.key === 'ArrowRight') hsv.s = clamp(hsv.s + step, 0, 1);
    else if (event.key === 'ArrowUp') hsv.v = clamp(hsv.v + step, 0, 1);
    else if (event.key === 'ArrowDown') hsv.v = clamp(hsv.v - step, 0, 1);
    else return;
    event.preventDefault();
    apply();
  });
  hue.addEventListener('input', () => {
    hsv.h = Number(hue.value);
    apply();
  });
  hexInput.addEventListener('input', () => {
    hexInput.classList.toggle('is-invalid', !normalizeHex(hexInput.value));
    const normalized = normalizeHex(hexInput.value);
    if (normalized && hexInput.value.length === 7) setColor(normalized);
  });
  hexInput.addEventListener('blur', () => {
    hexInput.classList.remove('is-invalid');
    if (!setColor(hexInput.value)) render();
  });
  hexInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (setColor(hexInput.value)) saturation.focus();
    }
  });

  pairs.forEach(({ input, trigger }) => {
    triggerOf.set(input, trigger);
    syncTrigger(input);
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      open(input, trigger);
    });
    input.addEventListener('input', () => syncTrigger(input));
  });

  document.addEventListener('pointerdown', (event) => {
    if (activeInput && !popover.contains(event.target) && !activeTrigger?.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeInput) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });
  window.addEventListener('resize', () => activeInput && positionPopover());
  window.addEventListener('scroll', () => activeInput && positionPopover(), true);

  return {
    sync: () => pairs.forEach(({ input }) => syncTrigger(input)),
    close
  };
};
