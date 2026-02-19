/**
 * @file uiController.js
 * @description UI 介面控制核心，管理所有樣式設定、語言選單、翻譯模式切換及 localStorage 持久化。
 */

// uiController.js 頂部
import { updateStatusDisplay } from './translationController.js';
import { setupPromptModelDownload } from './promptTranslationService.js';
import { setupLanguagePackButton } from './languagePackManager.js';
import { checkTranslationAvailability, monitorLocalTranslationAPI } from './translatorApiService.js';
import { browserInfo, loadLanguageConfig, setAlignment, setRayModeStatus, setForceSingleLineStatus, setDeepgramStatus } from './config.js';
import { Logger, LogLevel, setLogLevel } from './logger.js';

const setupToggleVisibility = (btnId, inputId) => {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (btn && input) {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMasked = input.classList.contains('input-masked');
      input.classList.toggle('input-masked', !isMasked);
      input.classList.toggle('input-visible', isMasked);

      const eyeOpen = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
      const eyeClosed = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      newBtn.innerHTML = isMasked ? eyeOpen : eyeClosed;
    });
  }
};

document.addEventListener('DOMContentLoaded', async function () {
  const urlParams = new URLSearchParams(window.location.search);
  const isDebugMode = urlParams.get('debug') === 'true';

  setLogLevel(isDebugMode ? LogLevel.DEBUG : LogLevel.INFO);
  Logger.info('UI', '應用程式初始化開始...');

  setTimeout(() => {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) statusDisplay.textContent = '';
  }, 7000);

  // #region [UI 配置定義]
  /** @type {Object} 系統統一設定配置表 */
  const CONFIG = {
    styles: [
      { id: 'source-font-color', target: 'source-text', css: '--text-color', type: 'color', desc: 'Source text' },
      { id: 'target1-font-color', target: 'target-text-1', css: '--text-color', type: 'color', desc: 'Target text 1' },
      { id: 'target2-font-color', target: 'target-text-2', css: '--text-color', type: 'color', desc: 'Target text 2' },
      { id: 'target3-font-color', target: 'target-text-3', css: '--text-color', type: 'color', desc: 'Target text 3' },
      { id: 'source-font-stroke-color', target: 'source-text', css: '--stroke-color', type: 'color', desc: 'Source stroke' },
      { id: 'target1-font-stroke-color', target: 'target-text-1', css: '--stroke-color', type: 'color', desc: 'Target stroke 1' },
      { id: 'target2-font-stroke-color', target: 'target-text-2', css: '--stroke-color', type: 'color', desc: 'Target stroke 2' },
      { id: 'target3-font-stroke-color', target: 'target-text-3', css: '--stroke-color', type: 'color', desc: 'Target stroke 3' },
      { id: 'source-font-size', target: 'source-text', css: '--text-font-size', type: 'range', desc: 'Source font size' },
      { id: 'target1-font-size', target: 'target-text-1', css: '--text-font-size', type: 'range', desc: 'Target font size 1' },
      { id: 'target2-font-size', target: 'target-text-2', css: '--text-font-size', type: 'range', desc: 'Target font size 2' },
      { id: 'target3-font-size', target: 'target-text-3', css: '--text-font-size', type: 'range', desc: 'Target font size 3' },
      { id: 'source-font-stroke-size', target: 'source-text', css: '--stroke-width', type: 'range', desc: 'Source stroke size' },
      { id: 'target1-font-stroke-size', target: 'target-text-1', css: '--stroke-width', type: 'range', desc: 'Target stroke size 1' },
      { id: 'target2-font-stroke-size', target: 'target-text-2', css: '--stroke-width', type: 'range', desc: 'Target stroke size 2' },
      { id: 'target3-font-stroke-size', target: 'target-text-3', css: '--stroke-width', type: 'range', desc: 'Target stroke size 3' }
    ],
    languages: [
      { id: 'source-language', type: 'select', desc: 'Source language' },
      { id: 'target1-language', type: 'select', desc: 'Target language 1', clearTarget: 'target-text-1' },
      { id: 'target2-language', type: 'select', desc: 'Target language 2', clearTarget: 'target-text-2' },
      { id: 'target3-language', type: 'select', desc: 'Target language 3', clearTarget: 'target-text-3' }
    ],
    radioGroups: [
      {
        name: 'alignment', key: 'text-alignment', default: 'center',
        targets: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
        css: '--text-align', desc: 'Text alignment',
        onChange: (val) => setAlignment(val), onLoad: (val) => setAlignment(val)
      },
      {
        name: 'overflow', key: 'overflow-mode', default: 'normal',
        targets: ['target-text-1', 'target-text-2', 'target-text-3'], desc: 'Overflow mode',
        onChange: (val, targets) => {
          targets.forEach(tId => {
            const el = document.getElementById(tId);
            if (el) {
              el.classList.remove('overflow-normal', 'overflow-truncate', 'overflow-shrink');
              el.classList.add(`overflow-${val}`);
            }
          });
        },
        onLoad: (val, targets) => {
          targets.forEach(tId => {
            const el = document.getElementById(tId);
            if (el) {
              el.classList.remove('overflow-normal', 'overflow-truncate', 'overflow-shrink');
              el.classList.add(`overflow-${val}`);
            }
          });
        }
      }
    ],
    special: [
      { id: 'display-panel-color', type: 'body-color', css: '--body-background', desc: 'Body background color' },
      { id: 'translation-link', type: 'text', desc: 'Translation link' },
      { id: 'gas-script-id', type: 'text', desc: 'GAS Script ID' },
      {
        id: 'raymode', type: 'checkbox', key: 'raymode-active', desc: 'Raymode active state',
        onChange: (checked) => setRayModeStatus(checked),
        onLoad: (checked) => setRayModeStatus(checked)
      },
      {
        id: 'click-minimize-opt', type: 'select', key: 'click-minimize-enabled', desc: 'Display panel click minimize', default: 'true'
      },
      {
        id: 'force-single-line-opt', type: 'select', key: 'force-single-line-enabled',
        desc: 'Force single line display', default: 'false',
        onChange: (val) => {
          const isEnabled = val === 'true';
          setForceSingleLineStatus(isEnabled);
          document.getElementById('source-text')?.classList.toggle('visual-single-line', isEnabled);
        },
        onLoad: (val) => {
          const isEnabled = val === 'true';
          setForceSingleLineStatus(isEnabled);
          document.getElementById('source-text')?.classList.toggle('visual-single-line', isEnabled);
        }
      },
      {
        id: 'speech-engine-opt', type: 'select', key: 'speech-recognition-engine', desc: 'Speech Recognition Engine', default: 'deepgram',
        onChange: (val) => {
          const isDeepgram = val === 'deepgram';
          setDeepgramStatus(isDeepgram ? 'true' : 'false');
          
          // 控制下載按鈕顯示 (僅 Chrome 且選擇 Web Speech API 時顯示)
          const dlBtn = document.getElementById('download-language-pack');
          if (dlBtn && browserInfo.isChrome) {
            // 等on device成為穩定版本時才開放使用
            // dlBtn.style.display = isDeepgram ? 'none' : 'flex';
            dlBtn.style.display = isDeepgram ? 'none' : 'none';
          }

          // 控制說明連結顯示 (僅 Deepgram 顯示)
          const helpLink = document.getElementById('engine-help-link');
          if (helpLink) {
            helpLink.style.display = isDeepgram ? 'inline-flex' : 'none';
          }
        },
        onLoad: (val) => {
          // [資料遷移] 檢查舊的 deepgram-enabled 設定
          const oldKey = 'deepgram-enabled';
          const oldVal = localStorage.getItem(oldKey);
          
          if (oldVal !== null) {
            val = oldVal === 'true' ? 'deepgram' : 'webspeech';
            localStorage.setItem('speech-recognition-engine', val);
            localStorage.removeItem(oldKey); // 移除舊設定
            const el = document.getElementById('speech-engine-opt');
            if (el) el.value = val;
          }

          const isDeepgram = val === 'deepgram';
          setDeepgramStatus(isDeepgram ? 'true' : 'false');

          const dlBtn = document.getElementById('download-language-pack');
          if (dlBtn && browserInfo.isChrome) {
            // dlBtn.style.display = isDeepgram ? 'none' : 'flex';
            dlBtn.style.display = isDeepgram ? 'none' : 'none';
          }

          const helpLink = document.getElementById('engine-help-link');
          if (helpLink) {
            helpLink.style.display = isDeepgram ? 'inline-flex' : 'none';
          }
        }
      },
      {
        id: 'log-level-opt', type: 'select', key: 'log-level-preference', desc: 'Console Log Level', default: '1',
        onChange: (val) => setLogLevel(parseInt(val, 10)), onLoad: (val) => setLogLevel(parseInt(val, 10))
      },
    ],
    panels: { 'Subtitle': 'source-styles-panel', 'options': 'options-panel' }
  };
  // #endregion

  // #region [瀏覽器功能限制檢查]
  if (!browserInfo.isChrome) {
    Logger.debug('[DEBUG] [UIController]', '檢測到 Edge 瀏覽器，限制本地端 API 功能');

    ['prompt-api-download', 'download-language-pack'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  // #endregion

  // #region [數據持久化處理器 (Storage)]
  const Storage = {
    /** 儲存數值至 localStorage */
    save: (key, value, desc) => {
      localStorage.setItem(key, value);
    },
    /** 從 localStorage 讀取數值 */
    load: (key, defaultValue = null) => {
      return localStorage.getItem(key) || defaultValue;
    },
    /** 取得 CSS :root 中的預設變數值 */
    getDefaultFromCSS: (cssProperty) => {
      return getComputedStyle(document.documentElement).getPropertyValue(cssProperty).trim();
    }
  };
  // #endregion

  // #region [工廠函式：設定處理器生成]

  /**
   * 生成標準輸入/樣式處理器
   * @param {Object} config - 設定項物件
   */
  const createSettingHandler = (config) => ({
    load() {
      const element = document.getElementById(config.id);
      const target = config.target ? document.getElementById(config.target) : null;
      if (!element) return;

      const saved = Storage.load(config.id);
      const value = saved || (config.css ? Storage.getDefaultFromCSS(config.css) : null);
      if (!value) return;

      element.value = config.type === 'range' ? parseFloat(value) : value;
      if (!target || !config.css) return;

      target.style.setProperty(config.css, value);
      if (config.css === '--text-font-size') {
        this.syncFontSizeProps(target, config.id, parseFloat(value));
      }
    },
    save(value) {
      Storage.save(config.id, value, config.desc);
      const target = config.target ? document.getElementById(config.target) : null;
      if (!target || !config.css) return;

      target.style.setProperty(config.css, value);
      if (config.css === '--text-font-size') {
        this.syncFontSizeProps(target, config.id, parseFloat(value));
      }
    },
    syncFontSizeProps(target, id, fontSize) {
      const overflowHeight = `${fontSize * 1.2}px`;
      const fontSizeHalf = `${fontSize * 0.75}px`;
      target.style.setProperty('--overflow-height', overflowHeight);
      target.style.setProperty('--font-size-half', fontSizeHalf);

      Storage.save(`${id}-overflow-height`, overflowHeight, `${config.desc} overflow height`);
      Storage.save(`${id}-font-size-half`, fontSizeHalf, `${config.desc} font size half`);
    },
    setupListener() {
      const element = document.getElementById(config.id);
      if (!element) return;

      element.addEventListener(config.type === 'select' ? 'change' : 'input', (e) => {
        const value = config.type === 'range' ? `${e.target.value}px` : e.target.value;
        this.save(value);
        if (config.id.includes('language')) {
          const mode = document.getElementById('translation-mode')?.value;
          if (mode === 'fast') { checkTranslationAvailability(); }
        }
        this.handleSpecialCases(e);
      });
    },
    handleSpecialCases(e) {
      if (!config.clearTarget || e.target.value !== 'none') return;
      const targetEl = document.getElementById(config.clearTarget);
      if (!targetEl) return;
      targetEl.textContent = '\u200B';
    },
    reset() {
      if (!config.css) return;
      const defaultValue = Storage.getDefaultFromCSS(config.css);
      if (!defaultValue) return;
      this.save(defaultValue);
      const element = document.getElementById(config.id);
      if (element) element.value = config.type === 'range' ? parseFloat(defaultValue) : defaultValue;
    }
  });

  /**
   * 生成 Radio 單選按鈕處理器
   * @param {Object} config 
   */
  const createRadioHandler = (config) => ({
    load() {
      const saved = Storage.load(config.key, config.default);

      // 執行注入的 onLoad 邏輯
      if (config.onLoad) config.onLoad(saved, config.targets);

      const radio = document.querySelector(`input[name="${config.name}"][value="${saved}"]`);
      if (radio) {
        radio.checked = true;
        this.save(saved, false); // false = 載入時不再次觸發 onChange，避免重複執行
      }
    },
    setupListener() {
      document.querySelectorAll(`input[name="${config.name}"]`).forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (e.target.checked) this.save(e.target.value, true);
        });
      });
    },
    save(value, triggerCallback = true) {
      Storage.save(config.key, value, config.desc);

      // 執行注入的 onChange 邏輯
      if (triggerCallback && config.onChange) config.onChange(value, config.targets);

      // 通用的 CSS 變數處理
      if (config.css && config.targets) {
        config.targets.forEach(targetId => {
          const target = document.getElementById(targetId);
          if (target) target.style.setProperty(config.css, value);
        });
      }
    },
    reset() {
      // 重置時也觸發 onLoad/onChange 來還原狀態
      if (config.onLoad) config.onLoad(config.default, config.targets);

      const defaultRadio = document.querySelector(`input[name="${config.name}"][value="${config.default}"]`);
      if (defaultRadio) {
        defaultRadio.checked = true;
        this.save(config.default, false);
      }
    }
  });

  /**
   * 生成特殊元件（Checkbox, Select, Body Color）處理器
   * @param {Object} config 
   */
  const createSpecialHandler = (config) => {
    const handlers = {
      'body-color': {
        load(el) {
          const value = Storage.load(config.id) || Storage.getDefaultFromCSS(config.css) || '#00FF00';
          el.value = value;
          document.body.style.setProperty(config.css, value);
        },
        setupListener(el) {
          el.addEventListener('input', (e) => {
            document.body.style.setProperty(config.css, e.target.value);
            Storage.save(config.id, e.target.value, config.desc);
          });
        },
        reset(el) {
          const def = Storage.getDefaultFromCSS(config.css) || '#00FF00';
          el.value = def;
          document.body.style.setProperty(config.css, def);
          Storage.save(config.id, def, config.desc);
        }
      },
      'text': {
        load(el) {
          const saved = Storage.load(config.id);
          if (saved) el.value = saved;
        },
        setupListener(el) {
          el.addEventListener('input', (e) => Storage.save(config.id, e.target.value, config.desc));
        },
        reset() { }
      },
      'checkbox': {
        load(el) {
          const saved = Storage.load(config.key) === 'true';
          el.checked = saved;
          if (config.onLoad) config.onLoad(saved);
        },
        setupListener(el) {
          el.addEventListener('change', (e) => {
            const checked = e.target.checked;
            Storage.save(config.key, checked.toString(), config.desc);
            if (config.onChange) config.onChange(checked);
          });
        },
        reset(el) {
          el.checked = false;
          Storage.save(config.key, 'false', config.desc);
          if (config.onChange) config.onChange(false);
        }
      },
      'select': {
        load(el) {
          const saved = Storage.load(config.key);
          const val = saved || config.default || 'false';
          el.value = val;

          if (config.onLoad) config.onLoad(val);
        },
        setupListener(el) {
          el.addEventListener('change', (e) => {
            const val = e.target.value;
            Storage.save(config.key, val, config.desc);
            if (config.onChange) config.onChange(val);
          });
        },
        reset(el) {
          const def = config.default || 'false';
          el.value = def;
          Storage.save(config.key, def, config.desc);
          if (config.onLoad) config.onLoad(def);
        }
      },
    };

    const handler = handlers[config.type];
    return {
      load() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.load(el);
      },
      setupListener() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.setupListener(el);
      },
      reset() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.reset(el);
      }
    };
  };
  // #endregion

  // #region [介面操作與面板管理]

  /** 面板切換與按鈕狀態管理 */
  const setupPanelSwitching = () => {
    const switchPanel = (buttonId) => {
      document.querySelectorAll('.menu-button').forEach(btn => btn.classList.remove('active'));
      document.getElementById(buttonId)?.classList.add('active');

      Object.values(CONFIG.panels).forEach(pId => {
        const p = document.getElementById(pId);
        if (p) p.style.display = 'none';
      });

      const target = document.getElementById(CONFIG.panels[buttonId]);
      if (target) target.style.display = 'flex';
    };

    document.querySelectorAll('.menu-button').forEach(btn => {
      btn.addEventListener('click', () => switchPanel(btn.id));
    });
  };

  /** 麥克風隱私遮罩 (避免實況中洩漏裝置名稱) */
  const setupMicPrivacyHandler = () => {
    const toggle = document.getElementById('mic-privacy-toggle');
    const cover = document.getElementById('mic-privacy-cover');
    const micInfo = document.querySelector('.mic-info');

    const defaultMicEl = document.getElementById('default-mic');
    const otherMicEl = document.getElementById('other-mic');

    if (!toggle || !cover) return;

    const updatePrivacyState = (isProtected) => {
      cover.style.display = isProtected ? 'flex' : 'none';
      toggle.checked = isProtected;

      if (micInfo) micInfo.style.overflowY = isProtected ? 'hidden' : 'auto';

      const contentVisibility = isProtected ? 'hidden' : 'visible';
      if (defaultMicEl) defaultMicEl.style.visibility = contentVisibility;
      if (otherMicEl) otherMicEl.style.visibility = contentVisibility;

      localStorage.setItem('mic-privacy-enabled', isProtected);
    };

    updatePrivacyState(localStorage.getItem('mic-privacy-enabled') === 'true');
    toggle.addEventListener('change', (e) => updatePrivacyState(e.target.checked));
  };

  /** 翻譯模式（GAS, Link, Fast, AI）切換邏輯 */
  const setupTranslationModeHandler = () => {
    const modeSelect = document.getElementById('translation-mode');
    const linkWrapper = document.getElementById('link-input-wrapper');
    const gasWrapper = document.getElementById('gas-input-wrapper');
    const promptDownloadBtn = document.getElementById('prompt-api-download');
    const fastModeControls = document.getElementById('fast-mode-controls');
    const fastModeProgress = document.getElementById('fast-mode-progress');

    setupToggleVisibility('toggle-link-visibility', 'translation-link');
    setupToggleVisibility('toggle-gas-visibility', 'gas-script-id');

    if (!modeSelect) return;

    const applyMode = (mode) => {
      // 先全部隱藏
      [linkWrapper, gasWrapper, promptDownloadBtn, fastModeControls].forEach(w => { if (w) w.style.display = 'none'; });
      if (fastModeProgress) fastModeProgress.textContent = '';

      // 重置狀態標記
      localStorage.setItem('local-translation-api-active', 'false');
      localStorage.setItem('local-prompt-api-active', 'false');
      //updateStatusDisplay('');

      switch (mode) {
        case 'gas':
          if (gasWrapper) { gasWrapper.style.display = 'block'; document.getElementById('gas-script-id')?.focus(); }
          break;
        case 'link':
          if (linkWrapper) { linkWrapper.style.display = 'block'; document.getElementById('translation-link')?.focus(); }
          break;
        case 'gemma':
          // [新增] Gemma 模式
          // 不需要顯示任何額外輸入框，因為連接的是 localhost:8080
          // 可以顯示一個簡單的狀態文字提醒用戶開啟後端
          //updateStatusDisplay('Local Gemma Mode: Ready (Ensure server is running on port 8080)');
          break;
        case 'fast':
          if (!browserInfo.isChrome) { alert('高速翻訳はEdgeに対応しておりません。'); applyMode('link'); return; }
          localStorage.setItem('local-translation-api-active', 'true');
          if (fastModeControls) fastModeControls.style.display = 'flex';
          checkTranslationAvailability();
          break;
        case 'ai':
          if (!browserInfo.isChrome) { alert('ブラウザAI翻訳はEdgeに対応しておりません。'); applyMode('link'); return; }
          localStorage.setItem('local-prompt-api-active', 'true');
          setupPromptModelDownload();
          break;
      }
      Storage.save('translation-mode-selection', mode, 'Translation Mode');
    };

    const savedMode = Storage.load('translation-mode-selection') || 'link';
    modeSelect.value = savedMode;
    // 確保如果存的是 gemma 但 select 裡還沒加入選項時的 fallback (雖然 HTML 會同步更新)
    applyMode(savedMode);
    
    modeSelect.addEventListener('change', (e) => applyMode(e.target.value));
  };

  /** 字幕面板點擊切換最小化 (擴大字幕區) */
  const setupDisplayPanelInteraction = () => {
    const dPanel = document.getElementById('display-panel');
    const cPanel = document.getElementById('control-panel');
    const sPanel = document.getElementById('status-panel');
    const minOpt = document.getElementById('click-minimize-opt');
    if (!dPanel || !cPanel || !sPanel) return;

    dPanel.addEventListener('click', () => {
      if (minOpt?.value === 'false') return;
      const isHidden = cPanel.style.display === 'none';
      cPanel.style.display = isHidden ? 'flex' : 'none';
      sPanel.style.display = isHidden ? 'flex' : 'none';
      dPanel.style.setProperty('--display-panel-height', isHidden ? '55%' : '95%');
    });
  };

  /** 全域重置按鈕邏輯 */
  const setupResetButton = (handlers) => {
    const rBtn = document.getElementById('reset-settings');
    if (rBtn) rBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Object.values(handlers).flat().forEach(h => { if (h.reset) h.reset(); });
    });
  };
  // #endregion

  /** * 鍵盤快捷鍵管理
   * 目前功能：Alt + B 切換字幕背景風格
   */
  const setupKeyboardShortcuts = () => {
    // 定義 Mode B 的詳細配置 (包含文字與 UI 鎖定狀態)
    const MODE_B_CONFIG = {
      active: {
        // 介面文字提示
        messages: {
          'source-text': '現在はモードBを使用しており、モードBでは言語3は使用できません。',
          'target-text-1': 'モードBでは字幕は3行固定で表示され、行数を超えた場合はスクロール表示となります。字幕サイズは固定されています。',
          'target-text-2': 'モードBは、素材と組み合わせた状態での使用を想定しています。',
          'target-text-3': ''
        },
        // 需要鎖定(Disable)的輸入框 ID 列表
        disabledInputs: [
          'source-font-size',
          'target1-font-size',
          'target2-font-size',
          'target3-font-size'
        ]
      },
      inactive: {
        messages: {
          'source-text': '',
          'target-text-1': '',
          'target-text-2': '',
          'target-text-3': ''
        },
        disabledInputs: [] // 恢復時沒有需要鎖定的東西
      }
    };

    document.addEventListener('keydown', (e) => {
      // 偵測組合鍵: Alt + B
      if (e.altKey && (e.code === 'KeyB' || e.key === 'b')) {
        e.preventDefault();

        const subtitleContainer = document.getElementById('Subtitle-style');
        if (subtitleContainer) {
          // 1. 切換狀態
          const isActive = subtitleContainer.classList.toggle('active-style');
          const config = isActive ? MODE_B_CONFIG.active : MODE_B_CONFIG.inactive;

          // 2. 更新文字 (Data-Driven)
          Object.entries(config.messages).forEach(([id, text]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
          });

          // 3. 控制滑桿鎖定狀態 (這是新增的部分)
          // 先取得所有可能被鎖定的 ID (從 active 列表拿)，然後根據目前的 isActive 決定是 true 還是 false
          MODE_B_CONFIG.active.disabledInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
              input.disabled = isActive; // Mode B 啟用時 -> disabled = true
            }
          });

          Logger.info('UI', `字幕背景風格已${isActive ? '啟用' : '停用'}`);
          localStorage.setItem('subtitle-style-active', isActive);
        }
      }
    });

    // (選用) 載入時恢復狀態的邏輯也需要同步更新
    const savedState = localStorage.getItem('subtitle-style-active') === 'true';
    if (savedState) {
      document.getElementById('Subtitle-style')?.classList.add('active-style');
      // 這裡建議呼叫一次上面的邏輯來鎖定滑桿，或者手動鎖定：
      MODE_B_CONFIG.active.disabledInputs.forEach(id => {
        const input = document.getElementById(id);
        if(input) input.disabled = true;
      });
    }
  };

  // #region [主初始化流程]
  await loadLanguageConfig();

  const handlers = {
    styleHandlers: CONFIG.styles.map(c => { const h = createSettingHandler(c); h.load(); h.setupListener(); return h; }),
    languageHandlers: CONFIG.languages.map(c => { const h = createSettingHandler(c); h.load(); h.setupListener(); return h; }),
    radioHandlers: CONFIG.radioGroups.map(c => { const h = createRadioHandler(c); h.load(); h.setupListener(); return h; }),
    specialHandlers: CONFIG.special.map(c => { const h = createSpecialHandler(c); h.load(); h.setupListener(); return h; })
  };

  setupPanelSwitching();
  setupResetButton(handlers);
  setupKeyboardShortcuts();
  await setupLanguagePackButton('source-language', updateStatusDisplay);
  monitorLocalTranslationAPI();
  setupDisplayPanelInteraction();
  setupTranslationModeHandler();
  setupMicPrivacyHandler();

  const defaultTab = document.getElementById('Subtitle');
  if (defaultTab) defaultTab.click();
  if (!browserInfo.isChrome) {
    const fastModeOption = document.querySelector('#translation-mode option[value="fast"]');
    if (fastModeOption) fastModeOption.disabled = true;
  } else {
    // 目前還處在實驗性質，最少也要等到Chrome 145+以後的版本才有機會使用到
    // 並且問題可能很多，非必要不建議使用。
    setupPromptModelDownload();
  };
  // #endregion

// #region [模式B字幕處理方式(CSS限制寬度和高度、超過使用滾動方式移動)]

  // 保持原有的緩動函數不變
  const smoothScrollToSlowly = (element, to, duration) => {
    const start = element.scrollTop;
    const change = to - start;
    const startTime = performance.now();

    const animateScroll = (currentTime) => {
      const elapsed = currentTime - startTime;
      const t = Math.min(1, elapsed / duration);
      const easeOut = t * (2 - t);

      element.scrollTop = start + (change * easeOut);

      if (elapsed < duration) { requestAnimationFrame(animateScroll); }
    };

    requestAnimationFrame(animateScroll);
  };

  /**
   * Source Text 專用滾動邏輯
   * 特性：即時響應、標準平滑滾動 (Native Smooth Scroll)
   * 適用於：Deepgram 或 Web Speech API 的即時語音轉錄顯示
   */
  const setupSourceScrollBehavior = (elementId) => {
    const el = document.getElementById(elementId);
    if (!el) return;

    const observer = new MutationObserver(() => {
      // 當內容高度大於可視高度時
      if (el.scrollHeight > el.clientHeight) {
        // Source 區塊：直接滾動到底部，讓用戶確認目前收音狀況
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth'
        });
      } else {
        el.scrollTop = 0;
      }
    });

    observer.observe(el, { childList: true, characterData: true, subtree: true });
  };

  /**
   * Target Text 專用滾動邏輯
   * 特性：防抖動 (Debounce)、延遲觸發、極慢速滾動 (Cinema Effect)
   */
  const setupTargetScrollBehavior = (elementId) => {
    const el = document.getElementById(elementId);
    if (!el) return;

    let activeScrollSession = null;

    // [定義] 核心滾動邏輯
    const startSmartScrolling = () => {
      const overflowMode = document.querySelector('input[name="overflow"]:checked')?.value;
      
      if (overflowMode === 'truncate') {
         // el.scrollTop = 0; // 若希望切換到省略模式時自動回頂部，可取消此行註解
         return;
      }
      
      if (overflowMode === 'shrink') {
        // === 模式 A: Shrink (提詞機循環滾動) ===
        const style = window.getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.3);
        const currentScroll = el.scrollTop;
        const maxScroll = el.scrollHeight - el.clientHeight;
        
        if (currentScroll < maxScroll - 1) {
          const targetScroll = Math.min(currentScroll + lineHeight, maxScroll);

          smoothScrollToSlowly(el, targetScroll, 800);

          activeScrollSession = setTimeout(() => { startSmartScrolling(); }, 2000); 
        }

      } else {
        // === 模式 B: Normal (一次到底) ===
        // 切換到 Normal 模式時，直接執行一次滑到底部
        smoothScrollToSlowly(el, el.scrollHeight, 6000);
      }
    };

    const observer = new MutationObserver(() => {
      if (activeScrollSession) {
        clearTimeout(activeScrollSession);
        activeScrollSession = null;
      }

      if (el.scrollHeight > el.clientHeight) {
        activeScrollSession = setTimeout(() => { startSmartScrolling(); }, 3000);
      } else {
        el.scrollTop = 0;
      }
    });

    observer.observe(el, { childList: true, characterData: true, subtree: true });

    document.querySelectorAll('input[name="overflow"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (activeScrollSession) {
          clearTimeout(activeScrollSession);
          activeScrollSession = null;
        }
        setTimeout(() => {
          if (el.scrollHeight > el.clientHeight) { startSmartScrolling(); }
          else { el.scrollTop = 0; }
        }, 100);
      });
    });
  };

  // 初始化 Source 滾動邏輯
  setupSourceScrollBehavior('source-text');

  // 初始化 Targets 滾動邏輯
  ['target-text-1', 'target-text-2', 'target-text-3'].forEach(id => {
    setupTargetScrollBehavior(id);
  });

  // #endregion
});