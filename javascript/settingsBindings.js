/**
 * @file settingsBindings.js
 * @description 把設定項目宣告成一張表，再由三個處理器工廠統一負責
 *              「載入 → 監聽 → 重設」。新增一個設定項目應該只需要在
 *              settingsStore.js 的 SETTING_DEFAULTS 加預設值、在 CONFIG 加一列。
 *
 * 【storage key 的規則】一律使用 config.key；省略時退回 config.id。
 * 以前樣式與語言用 id、其他用 key，兩套慣例並存，obs-ws-ip 這類項目
 * 是靠「id 剛好等於 obsBridge 用的 key」才對上的。
 */

import {
  browserInfo, setAlignment, setForceSingleLineStatus, setSpeechEngine, setSonioxEndpointSetting
} from './config.js';
import { getSetting, setSetting, SETTING_DEFAULTS } from './settingsStore.js';
import { createLogger, setLogLevel } from './logger.js';
import { handleObsBridgeSettingsChanged, refreshObsDragLinks } from './obsBridge.js';

const log = createLogger('SettingsBindings');

/** OBS 連線設定的套用節流時間。 */
const OBS_APPLY_DEBOUNCE_MS = 300;

/**
 * 顯示／隱藏元素。
 * 過去用 element.style.display = '' 還原顯示狀態，但那只在元素原本沒有
 * inline style 時才成立（HTML 裡寫死 style="display:none" 的元素還原不回來）。
 * 改用 hidden 屬性，顯示時該用什麼 display 交還給 CSS 決定。
 */
const setHidden = (element, hidden) => {
  if (element) element.hidden = hidden;
};

const debounce = (fn, waitMs) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, waitMs);
  };
};

/**
 * OBS 的設定變更集中在這裡節流。
 * handleObsBridgeSettingsChanged() 發現 URL 或密碼變了就會斷線重連，
 * 而 IP／連接埠／密碼都是 input 事件，等於每打一個字就重連一次。
 * 啟動時四個欄位也會各觸發一次，節流後合併成一次。
 */
const applyObsSettings = debounce(() => {
  handleObsBridgeSettingsChanged();
  refreshObsDragLinks();
}, OBS_APPLY_DEBOUNCE_MS);

// #region [UI 設定定義]
/** @type {Object} 集中處理 UI 設定的共用定義。預設值一律取自 SETTING_DEFAULTS。 */
export const CONFIG = {
  styles: [
    { id: 'source-font-color', target: 'source-text', css: '--text-color', type: 'color' },
    { id: 'target1-font-color', target: 'target-text-1', css: '--text-color', type: 'color' },
    { id: 'target2-font-color', target: 'target-text-2', css: '--text-color', type: 'color' },
    { id: 'target3-font-color', target: 'target-text-3', css: '--text-color', type: 'color' },
    { id: 'source-font-stroke-color', target: 'source-text', css: '--stroke-color', type: 'color' },
    { id: 'target1-font-stroke-color', target: 'target-text-1', css: '--stroke-color', type: 'color' },
    { id: 'target2-font-stroke-color', target: 'target-text-2', css: '--stroke-color', type: 'color' },
    { id: 'target3-font-stroke-color', target: 'target-text-3', css: '--stroke-color', type: 'color' },
    { id: 'source-font-size', target: 'source-text', css: '--text-font-size', type: 'range' },
    { id: 'target1-font-size', target: 'target-text-1', css: '--text-font-size', type: 'range' },
    { id: 'target2-font-size', target: 'target-text-2', css: '--text-font-size', type: 'range' },
    { id: 'target3-font-size', target: 'target-text-3', css: '--text-font-size', type: 'range' },
    { id: 'source-font-stroke-size', target: 'source-text', css: '--stroke-width', type: 'range' },
    { id: 'target1-font-stroke-size', target: 'target-text-1', css: '--stroke-width', type: 'range' },
    { id: 'target2-font-stroke-size', target: 'target-text-2', css: '--stroke-width', type: 'range' },
    { id: 'target3-font-stroke-size', target: 'target-text-3', css: '--stroke-width', type: 'range' }
  ],
  languages: [
    { id: 'source-language', type: 'select', langTarget: 'source-text', onApply: () => applyObsSettings() },
    { id: 'target1-language', type: 'select', langTarget: 'target-text-1', clearTarget: 'target-text-1', onApply: () => applyObsSettings() },
    { id: 'target2-language', type: 'select', langTarget: 'target-text-2', clearTarget: 'target-text-2', onApply: () => applyObsSettings() },
    { id: 'target3-language', type: 'select', langTarget: 'target-text-3', clearTarget: 'target-text-3', onApply: () => applyObsSettings() }
  ],
  radioGroups: [
    {
      name: 'alignment', key: 'text-alignment',
      targets: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
      css: '--text-align',
      onApply: (val) => setAlignment(val)
    }
  ],
  special: [
    { id: 'display-panel-color', type: 'body-color', css: '--body-background' },
    { id: 'translation-link', type: 'text' },
    { id: 'obs-ws-enabled', type: 'select', onApply: () => applyObsSettings() },
    { id: 'obs-ws-ip', type: 'text', onApply: () => applyObsSettings() },
    { id: 'obs-ws-port', type: 'text', onApply: () => applyObsSettings() },
    { id: 'obs-ws-password', type: 'text', onApply: () => applyObsSettings() },
    { id: 'click-minimize-opt', type: 'select', key: 'click-minimize-enabled' },
    {
      id: 'force-single-line-opt', type: 'select', key: 'force-single-line-enabled',
      onApply: (val) => {
        const isEnabled = val === 'true';
        setForceSingleLineStatus(isEnabled);
        document.getElementById('source-text')?.classList.toggle('visual-single-line', isEnabled);
      }
    },
    {
      id: 'speech-engine-opt', type: 'select', key: 'speech-recognition-engine',
      onApply: (val) => {
        setSpeechEngine(val);
        const isCloud = val === 'soniox';

        // 離線語言套件只有 on-device（Web Speech）用得到，使用 Soniox 時隱藏。
        // Chrome 以外的瀏覽器整列都不提供，由 applyBrowserLimits() 另外處理。
        if (browserInfo.isChrome) {
          setHidden(document.getElementById('download-language-pack')?.closest('.settings-row'), isCloud);
        }

        setHidden(document.getElementById('engine-help-link'), !isCloud);
        // 端點偵測調整是 Soniox 專用功能。
        setHidden(document.getElementById('soniox-endpoint-rows'), !isCloud);
      }
    },
    {
      id: 'soniox-latency-level-opt', type: 'select', key: 'soniox-latency-level',
      onApply: (val) => setSonioxEndpointSetting('latencyLevel', val)
    },
    {
      id: 'soniox-sensitivity-opt', type: 'range-value', key: 'soniox-sensitivity',
      valueId: 'soniox-sensitivity-value',
      format: (v) => Number(v).toFixed(1),
      onApply: (val) => setSonioxEndpointSetting('sensitivity', val)
    },
    {
      id: 'soniox-max-delay-opt', type: 'range-value', key: 'soniox-max-delay-ms',
      valueId: 'soniox-max-delay-value',
      format: (v) => `${v}ms`,
      onApply: (val) => setSonioxEndpointSetting('maxDelayMs', val)
    },
    // logger.js 讀的就是這個 key。以前這個選單另外存在 'log-level-preference'，
    // 於是用 ?debug=true 開啟時寫入的值，會馬上被選單載入的預設值覆蓋掉。
    {
      id: 'log-level-opt', type: 'select', key: 'log-system-debug-enabled',
      onApply: (val) => setLogLevel(val)
    },
    {
      id: 'auto-stop-enabled-opt', type: 'select', key: 'auto-stop-enabled',
      onApply: (val) => setHidden(document.getElementById('auto-stop-warning-badge'), val !== 'false')
    },
    // 暫停時長與無聲清除秒數由 speechCapture.js 在需要時透過 settingsStore 讀取，
    // 因此這裡不需要 onApply。
    { id: 'pause-duration-opt', type: 'select', key: 'pause-duration-min' },
    { id: 'subtitle-clear-idle-opt', type: 'select', key: 'subtitle-clear-idle-sec' }
  ]
};
// #endregion

// #region [設定儲存處理]
const storageKeyOf = (config) => config.key || config.id;

const getDefaultFromCSS = (cssProperty) =>
  getComputedStyle(document.documentElement).getPropertyValue(cssProperty).trim();

/** 設定項目的預設值。表列之外（樣式類）則回退到 CSS 自訂屬性。 */
const defaultOf = (config) => {
  const preset = SETTING_DEFAULTS[storageKeyOf(config)];
  if (preset !== undefined) return preset;
  return config.css ? getDefaultFromCSS(config.css) : null;
};

const Storage = {
  save: (config, value) => setSetting(storageKeyOf(config), value),
  load: (config) => getSetting(storageKeyOf(config), config.css ? getDefaultFromCSS(config.css) : null)
};
// #endregion

// #region [產生設定處理器]

/**
 * 產生處理標準輸入項目與樣式項目的處理器。
 * @param {Object} config - 設定項目的定義
 */
const createSettingHandler = (config) => {
  const element = document.getElementById(config.id);
  const target = config.target ? document.getElementById(config.target) : null;
  const apply = config.onApply;

  return {
    applyLanguage(value) {
      if (!config.langTarget) return;
      const targetEl = document.getElementById(config.langTarget);
      if (!targetEl) return;
      const lang = value && value !== 'none' ? value : '';
      if (lang) targetEl.lang = lang;
      else targetEl.removeAttribute('lang');
    },
    load() {
      if (!element) return;

      const value = Storage.load(config);
      if (!value) return;

      element.value = config.type === 'range' ? parseFloat(value) : value;
      this.applyLanguage(value);
      if (target && config.css) target.style.setProperty(config.css, value);
    },
    save(value) {
      Storage.save(config, value);
      this.applyLanguage(value);
      if (target && config.css) target.style.setProperty(config.css, value);
    },
    setupListener() {
      if (!element) return;

      element.addEventListener(config.type === 'select' ? 'change' : 'input', (event) => {
        const value = config.type === 'range' ? `${event.target.value}px` : event.target.value;
        this.save(value);
        this.clearTargetWhenNone(event.target.value);
        if (apply) apply(value);
      });
    },
    /** 語言選成「none」時，把對應的字幕欄清成不佔高度的零寬空白。 */
    clearTargetWhenNone(value) {
      if (!config.clearTarget || value !== 'none') return;
      const targetEl = document.getElementById(config.clearTarget);
      if (targetEl) targetEl.textContent = '\u200B';
    },
    reset() {
      const defaultValue = defaultOf(config);
      if (!defaultValue) return;
      this.save(defaultValue);
      if (element) element.value = config.type === 'range' ? parseFloat(defaultValue) : defaultValue;
    }
  };
};

/**
 * 產生單選按鈕用的設定處理器。
 * @param {Object} config
 */
const createRadioHandler = (config) => {
  const apply = config.onApply;

  return {
    load() {
      const saved = Storage.load(config);

      if (apply) apply(saved, config.targets);

      const radio = document.querySelector(`input[name="${config.name}"][value="${saved}"]`);
      if (radio) {
        radio.checked = true;
        this.save(saved, false); // 載入時不重新執行 onApply，以避免重複處理。
      }
    },
    setupListener() {
      document.querySelectorAll(`input[name="${config.name}"]`).forEach(radio => {
        radio.addEventListener('change', (event) => {
          if (event.target.checked) this.save(event.target.value, true);
        });
      });
    },
    save(value, triggerCallback = true) {
      Storage.save(config, value);

      if (triggerCallback && apply) apply(value, config.targets);

      if (config.css && config.targets) {
        config.targets.forEach(targetId => {
          const target = document.getElementById(targetId);
          if (target) target.style.setProperty(config.css, value);
        });
      }
    },
    reset() {
      const defaultValue = defaultOf(config);
      if (apply) apply(defaultValue, config.targets);

      const defaultRadio = document.querySelector(`input[name="${config.name}"][value="${defaultValue}"]`);
      if (defaultRadio) {
        defaultRadio.checked = true;
        this.save(defaultValue, false);
      }
    }
  };
};

/**
 * 產生下拉選單、背景色、滑桿等特殊項目用的處理器。
 * @param {Object} config
 */
const createSpecialHandler = (config) => {
  const apply = config.onApply;
  const applyValue = (value) => { if (apply) apply(value); };

  const handlers = {
    'body-color': {
      load(el) {
        const value = Storage.load(config) || '#00FF00';
        el.value = value;
        document.body.style.setProperty(config.css, value);
      },
      setupListener(el) {
        el.addEventListener('input', (event) => {
          document.body.style.setProperty(config.css, event.target.value);
          Storage.save(config, event.target.value);
        });
      },
      reset(el) {
        const defaultValue = defaultOf(config) || '#00FF00';
        el.value = defaultValue;
        document.body.style.setProperty(config.css, defaultValue);
        Storage.save(config, defaultValue);
      }
    },
    'text': {
      load(el) {
        const saved = Storage.load(config);
        if (saved) el.value = saved;
        applyValue(el.value || '');
      },
      setupListener(el) {
        el.addEventListener('input', (event) => {
          Storage.save(config, event.target.value);
          applyValue(event.target.value);
        });
      },
      // 文字欄位刻意不參與「全部重設」。翻訳クラウド接続 的 URL 與 OBS 的密碼
      // 都是使用者貼進來、重打成本很高的資料，樣式重設不該一起清掉。
      reset() { }
    },
    'select': {
      load(el) {
        const value = Storage.load(config);
        el.value = value;
        applyValue(value);
      },
      setupListener(el) {
        el.addEventListener('change', (event) => {
          Storage.save(config, event.target.value);
          applyValue(event.target.value);
        });
      },
      reset(el) {
        const defaultValue = defaultOf(config);
        el.value = defaultValue;
        Storage.save(config, defaultValue);
        applyValue(defaultValue);
      }
    },
    // 數值滑桿＋目前數值的文字顯示。使用 config.format 組合顯示字串。
    'range-value': {
      _render(el) {
        const label = document.getElementById(config.valueId);
        if (label) label.textContent = config.format ? config.format(el.value) : el.value;
      },
      load(el) {
        el.value = Storage.load(config);
        this._render(el);
        applyValue(el.value);
      },
      setupListener(el) {
        el.addEventListener('input', (event) => {
          Storage.save(config, event.target.value);
          this._render(event.target);
          applyValue(event.target.value);
        });
      },
      reset(el) {
        el.value = defaultOf(config);
        Storage.save(config, el.value);
        this._render(el);
        applyValue(el.value);
      }
    }
  };

  const element = document.getElementById(config.id);
  const handler = handlers[config.type];

  // config.type 打錯字會讓整個設定項目失效，而且是安靜地失效，所以在此出聲。
  if (!handler) {
    log.warn(`未知的設定型別: ${config.type}（id=${config.id}）`);
  }

  const run = (method) => { if (element && handler) handler[method](element); };
  return {
    load: () => run('load'),
    setupListener: () => run('setupListener'),
    reset: () => run('reset')
  };
};
// #endregion

// #region [建立與重設]

/** Chrome 以外的瀏覽器不支援 on-device 語言套件，整列隱藏。 */
const applyBrowserLimits = () => {
  if (browserInfo.isChrome) return;
  log.debug('非 Chrome 瀏覽器，限制本地端 API 功能');
  setHidden(document.getElementById('download-language-pack')?.closest('.settings-row'), true);
};

/**
 * 建立所有設定處理器，並完成載入與監聽。
 * @returns {{ resetAll: () => void }}
 */
export function bindSettings() {
  applyBrowserLimits();

  const handlers = [
    ...CONFIG.styles.map(createSettingHandler),
    ...CONFIG.languages.map(createSettingHandler),
    ...CONFIG.radioGroups.map(createRadioHandler),
    ...CONFIG.special.map(createSpecialHandler)
  ];

  handlers.forEach(handler => {
    handler.load();
    handler.setupListener();
  });

  return {
    resetAll: () => handlers.forEach(handler => handler.reset())
  };
}
// #endregion
