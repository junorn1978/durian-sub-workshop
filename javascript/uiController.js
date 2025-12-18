import { updateStatusDisplay } from './translationController.js';
import { loadLanguageConfig, getAllLanguages, setRayModeStatus, setForceSingleLineStatus, setDeepgramStatus } from './config.js';
import { setupPromptModelDownload } from './promptTranslationService.js';
import { setupLanguagePackButton } from './languagePackManager.js';
import { monitorLocalTranslationAPI } from './translatorApiService.js';
import { browserInfo } from './config.js';
import { Logger, LogLevel, setLogLevel } from './logger.js';

document.addEventListener('DOMContentLoaded', async function () {
  const urlParams = new URLSearchParams(window.location.search);
  const isDebugMode = urlParams.get('debug') === 'true';
  
  // 如果網址有 debug=true 則顯示 DEBUG，否則只顯示 INFO 以上
  setLogLevel(isDebugMode ? LogLevel.DEBUG : LogLevel.INFO);
  
  Logger.info('UI', '應用程式初始化開始...');

  // 7秒後清除狀態顯示
  setTimeout(() => {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
      statusDisplay.textContent = '';
    }
  }, 7000);

  // 統一的設定配置
  const CONFIG = {
    // 樣式設定
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

    // 語言選單
    languages: [
      { id: 'source-language', type: 'select', desc: 'Source language' },
      { id: 'target1-language', type: 'select', desc: 'Target language 1', clearTarget: 'target-text-1' },
      { id: 'target2-language', type: 'select', desc: 'Target language 2', clearTarget: 'target-text-2' },
      { id: 'target3-language', type: 'select', desc: 'Target language 3', clearTarget: 'target-text-3' }
    ],

    // 單選按鈕群組
    radioGroups: [
      {
        name: 'alignment',
        key: 'text-alignment',
        default: 'center',
        targets: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
        css: '--text-align',
        desc: 'Text alignment'
      },
      {
        name: 'overflow',
        key: 'overflow-mode',
        default: 'normal',
        targets: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
        desc: 'Overflow mode'
      }
    ],

    // 特殊設定
    special: [
      { id: 'display-panel-color', type: 'body-color', css: '--body-background', desc: 'Body background color' },
      { id: 'translation-link', type: 'text', desc: 'Translation link' },
      { id: 'gas-script-id', type: 'text', desc: 'GAS Script ID' },
      { id: 'raymode', type: 'checkbox', key: 'raymode-active', desc: 'Raymode active state' },
      { id: 'click-minimize-opt', type: 'select', key: 'click-minimize-enabled', desc: 'Display panel click minimize' },
      { id: 'force-single-line-opt', type: 'select', key: 'force-single-line-enabled', desc: 'Force single line display' },
      { id: 'deepgram-enabled', type: 'select', key: 'deepgram-enabled', desc: 'Deepgram enabled state' },
      { id: 'log-level-opt', type: 'select', key: 'log-level-preference', desc: 'Console Log Level' },
    ],

    // 面板對應
    panels: {
      'Subtitle': 'source-styles-panel',
      'options': 'options-panel'
    }
  };

  // 瀏覽器檢查
  if (!browserInfo.isChrome) {
    Logger.debug('[DEBUG] [UIController]', '檢測到 Edge 瀏覽器，限制本地端 API 功能');
    document.getElementById('status-display').textContent = '高速翻訳とブラウザAI翻訳はEdgeに対応しておりません。ご了承ください。';

    const downloadButton = document.getElementById('prompt-api-download');
    if (downloadButton) {
      downloadButton.style.display = 'none';
    }

    const languagePackButton = document.getElementById('download-language-pack');
    if (languagePackButton) {
      languagePackButton.style.display = 'none';
    }
  }

  // 通用的 localStorage 操作
  const Storage = {
    save: (key, value, desc) => {
      localStorage.setItem(key, value);
      //Logger.debug('[DEBUG] [UIController]', `${desc} 已儲存至 localStorage`);
    },

    load: (key, defaultValue = null) => {
      return localStorage.getItem(key) || defaultValue;
    },

    getDefaultFromCSS: (cssProperty) => {
      return getComputedStyle(document.documentElement).getPropertyValue(cssProperty).trim();
    }
  };

  // 設定處理器工廠
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

      if (!config.target || !config.css) return;

      const target = document.getElementById(config.target);
      if (!target) return;

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

        this.handleSpecialCases(e);
      });
    },

    handleSpecialCases(e) {
      if (!config.clearTarget || e.target.value !== 'none') return;

      const targetEl = document.getElementById(config.clearTarget);
      if (!targetEl) return;

      targetEl.textContent = '\u200B';
      targetEl.setAttribute("data-stroke", "\u200B");
    },

    reset() {
      if (!config.css) return;

      const defaultValue = Storage.getDefaultFromCSS(config.css);
      if (!defaultValue) return;

      this.save(defaultValue);
      const element = document.getElementById(config.id);
      if (!element) return;

      element.value = config.type === 'range' ? parseFloat(defaultValue) : defaultValue;
    }
  });

  // 單選按鈕群組處理器
  const createRadioHandler = (config) => ({

    load() {
      const saved = Storage.load(config.key, config.default);
      const radio = document.querySelector(`input[name="${config.name}"][value="${saved}"]`);
      if (radio) {
        radio.checked = true;
        this.save(saved);
      }
    },

    setupListener() {
      document.querySelectorAll(`input[name="${config.name}"]`).forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (e.target.checked) {
            this.save(e.target.value);
          }
        });
      });
    },

    save(value) {
      Storage.save(config.key, value, config.desc);
      config.targets.forEach(targetId => {
        const target = document.getElementById(targetId);
        if (target) {
          if (config.css) {
            target.style.setProperty(config.css, value);
          }
          if (config.name === 'overflow') {
            target.classList.remove('overflow-normal', 'overflow-truncate', 'overflow-shrink');
            target.classList.add(`overflow-${value}`);
          }
        }
      });
    },

    reset() {
      const defaultRadio = document.querySelector(`input[name="${config.name}"][value="${config.default}"]`);
      if (defaultRadio) {
        defaultRadio.checked = true;
        this.save(config.default);
      }
    }
  });

  // 特殊設定處理器
  const createSpecialHandler = (config) => {
    const handlers = {
      'body-color': {
        load(element) {
          const saved = Storage.load(config.id);
          const defaultValue = Storage.getDefaultFromCSS(config.css) || '#00FF00';
          const value = saved || defaultValue;

          element.value = value;
          document.body.style.setProperty(config.css, value);
        },

        setupListener(element) {
          element.addEventListener('input', (e) => {
            document.body.style.setProperty(config.css, e.target.value);
            Storage.save(config.id, e.target.value, config.desc);
          });
        },

        reset(element) {
          const defaultValue = Storage.getDefaultFromCSS(config.css) || '#00FF00';
          element.value = defaultValue;
          document.body.style.setProperty(config.css, defaultValue);
          Storage.save(config.id, defaultValue, config.desc);
        }
      },

      'text': {
        load(element) {
          const saved = Storage.load(config.id);
          if (saved) element.value = saved;
        },

        setupListener(element) {
          element.addEventListener('input', (e) => {
            Storage.save(config.id, e.target.value, config.desc);
          });
        },

        reset() { }
      },

      // [新增] Checkbox 專用處理器
      'checkbox': {
        load(element) {
          const saved = Storage.load(config.key) === 'true';
          element.checked = saved; // 恢復勾選狀態

          if (config.id === 'raymode') { setRayModeStatus(saved); }
        },

        setupListener(element) {
          // Checkbox 使用 'change' 事件
          element.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            Storage.save(config.key, isChecked.toString(), config.desc);

            if (config.id === 'raymode') { setRayModeStatus(isChecked); }
          });
        },

        reset(element) {
          element.checked = false;
          Storage.save(config.key, 'false', config.desc);

          if (config.id === 'raymode') setRayModeStatus(false);
        }
      },

      // 下拉選單專用處理器 (通用)
      'select': {
        load(element) {
          const saved = Storage.load(config.key);
          
          // [修正] 定義預設值邏輯
          // force-single-line-opt 和 deepgram-enabled 預設應該是 'false'
          // click-minimize-opt 預設是 'true'
          let defaultValue = 'true';
          if (config.id === 'force-single-line-opt' || config.id === 'deepgram-enabled') {
            defaultValue = 'false';
          }

          if (config.id === 'log-level-opt') {
            defaultValue = '1'; 
          }
          
          const value = saved ? saved : defaultValue;
          element.value = value;

          // 針對強制單行，直接操作 CSS Class
          if (config.id === 'force-single-line-opt') {
            const sourceText = document.getElementById('source-text');
            if (sourceText) {
              if (value === 'true') {
                sourceText.classList.add('visual-single-line');
              } else {
                sourceText.classList.remove('visual-single-line');
              }
            }
            setForceSingleLineStatus(value === 'true');
          }

          if (config.id === 'deepgram-enabled') {
            setDeepgramStatus(element.value);
          }

          if (config.id === 'log-level-opt') {
            // 注意：從 localStorage 讀出來的是字串，建議轉數字，不過 logger.js 比較運算時通常會自動轉型，保險起見用 parseInt
            setLogLevel(parseInt(value, 10));
          }
        },

        setupListener(element) {
          element.addEventListener('change', (e) => {
            const value = e.target.value;
            Storage.save(config.key, value, config.desc);
            Logger.debug('[DEBUG] [UI]', `${config.desc} 設定變更: ${value}`);

            if (config.id === 'force-single-line-opt') {
              const sourceText = document.getElementById('source-text');
              if (sourceText) {
                if (value === 'true') {
                  sourceText.classList.add('visual-single-line');
                } else {
                  sourceText.classList.remove('visual-single-line');
                }
              }
              setForceSingleLineStatus(value === 'true');
            }

            if (config.id === 'deepgram-enabled') {
              setDeepgramStatus(value);
              Logger.debug('[DEBUG]', '[UIController]', `Deepgram 狀態變更: ${value}`);
            }

            if (config.id === 'log-level-opt') {
              setLogLevel(parseInt(value, 10));
              // 可以在這裡印一行測試，確認切換成功
              console.info(`[INFO] [UIController] Log Level changed to: ${value}`);
            }
          });
        },

        reset(element) {
          // [修正] 重置時的邏輯也要同步修改
          let defaultVal = 'true';
          if (config.id === 'force-single-line-opt' || config.id === 'deepgram-enabled') {
            defaultVal = 'false';
          }

          element.value = defaultVal;
          Storage.save(config.key, defaultVal, config.desc);

          // 重置時移除 Class
          if (config.id === 'force-single-line-opt') {
            const sourceText = document.getElementById('source-text');
            if (sourceText) sourceText.classList.remove('visual-single-line');
            setForceSingleLineStatus(false);
          }

          // 重置時關閉 Deepgram
          if (config.id === 'deepgram-enabled') {
            setDeepgramStatus('false');
          }

          if (config.id === 'log-level-opt') {
                 element.value = '1'; // 預設 INFO
                 Storage.save(config.key, '1', config.desc);
                 setLogLevel(1);
          }
        }
      },
    };

    const handler = handlers[config.type];

    return {
      load() {
        const element = document.getElementById(config.id);
        if (!element || !handler) return;
        handler.load(element);
      },

      setupListener() {
        const element = document.getElementById(config.id);
        if (!element || !handler) return;
        handler.setupListener(element);
      },

      reset() {
        const element = document.getElementById(config.id);
        if (!element || !handler) return;
        handler.reset(element);
      }
    };
  };

  // 初始化所有設定
  const initializeSettings = () => {

    // 樣式設定
    const styleHandlers = CONFIG.styles.map(config => {
      const handler = createSettingHandler(config);
      handler.load();
      handler.setupListener();
      return handler;
    });

    // 語言設定
    const languageHandlers = CONFIG.languages.map(config => {
      const handler = createSettingHandler(config);
      handler.load();
      handler.setupListener();
      return handler;
    });

    // 單選按鈕群組
    const radioHandlers = CONFIG.radioGroups.map(config => {
      const handler = createRadioHandler(config);
      handler.load();
      handler.setupListener();
      return handler;
    });

    // 特殊設定
    const specialHandlers = CONFIG.special.map(config => {
      const handler = createSpecialHandler(config);
      handler.load();
      handler.setupListener();
      return handler;
    });

    return { styleHandlers, languageHandlers, radioHandlers, specialHandlers };
  };

  // 面板切換處理
  const setupPanelSwitching = () => {
    const switchPanel = (buttonId) => {
      // 移除所有按鈕的 active 類
      document.querySelectorAll('.menu-button').forEach(btn => btn.classList.remove('active'));
      document.getElementById(buttonId)?.classList.add('active');

      // 隱藏所有面板，顯示目標面板
      Object.values(CONFIG.panels).forEach(panelId => {
        const panel = document.getElementById(panelId);
        if (panel) panel.style.display = 'none';
      });

      const targetPanel = document.getElementById(CONFIG.panels[buttonId]);
      if (targetPanel) targetPanel.style.display = 'flex';
    };

    // 綁定面板切換按鈕
    document.querySelectorAll('.menu-button').forEach(button => {
      button.addEventListener('click', () => switchPanel(button.id));
    });

    // API link 特殊處理
    const apiLinkButton = document.getElementById('apilink');
    if (apiLinkButton) {
      apiLinkButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = apiLinkButton.classList.contains('active');
        const translationLink = document.getElementById('translation-link');
        const menuButtons = document.querySelectorAll('.status-button');
        const menu3Buttons = document.querySelectorAll('.menu3-button');
        const rayModeButton = document.querySelectorAll('.capsule-checkbox-label');

        if (!translationLink) return;

        apiLinkButton.classList.toggle('active');
        menuButtons.forEach(btn => btn.style.display = isActive ? 'inline-block' : 'none');
        menu3Buttons.forEach(btn => btn.style.display = isActive ? 'inline-block' : 'none');
        rayModeButton.forEach(btn => btn.style.display = isActive ? 'flex' : 'none');
        //rayButtons.style.display = isActive ? 'inline-block' : 'none';
        translationLink.style.display = isActive ? 'none' : 'inline-block';
      });
    }
  };

  // [新增] 麥克風隱私遮罩處理
  const setupMicPrivacyHandler = () => {
    const toggle = document.getElementById('mic-privacy-toggle');
    const cover = document.getElementById('mic-privacy-cover');
    const micInfo = document.querySelector('.mic-info');

    if (!toggle || !cover) return;

    // 定義狀態更新邏輯
    const updatePrivacyState = (isProtected) => {
      // 顯示或隱藏遮罩
      cover.style.display = isProtected ? 'flex' : 'none';
      toggle.checked = isProtected;

      micInfo.style.overflowY = isProtected ? 'hidden' : 'auto';

      // 儲存狀態
      localStorage.setItem('mic-privacy-enabled', isProtected);
      Logger.debug('[DEBUG]', '[UIController]', `麥克風隱私模式: ${isProtected ? '開啟' : '關閉'}`);
    };

    // 初始化：讀取上次設定
    const savedState = localStorage.getItem('mic-privacy-enabled') === 'true';
    updatePrivacyState(savedState);

    // 監聽變更
    toggle.addEventListener('change', (e) => {
      updatePrivacyState(e.target.checked);
    });
  };

  // 翻譯模式下拉選單與輸入框處理
  const setupTranslationModeHandler = () => {
    const modeSelect = document.getElementById('translation-mode');
    
    // 取得各個區塊
    const linkWrapper = document.getElementById('link-input-wrapper');
    const linkInput = document.getElementById('translation-link');
    const gasWrapper = document.getElementById('gas-input-wrapper');
    const gasInput = document.getElementById('gas-script-id');
    const promptDownloadBtn = document.getElementById('prompt-api-download');

    // [新增] 高速翻譯專用控制區
    const fastModeControls = document.getElementById('fast-mode-controls');
    const fastModeProgress = document.getElementById('fast-mode-progress');

    // --- 輔助函式：綁定顯示/隱藏密碼的眼睛按鈕 ---
    const setupToggleVisibility = (btnId, inputId) => {
      const btn = document.getElementById(btnId);
      const input = document.getElementById(inputId);
      
      if (btn && input) {
        // 複製按鈕以移除舊的 EventListener (保持原邏輯)
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          
          // [修改點] 不再切換 type，而是切換 CSS class
          // 檢查目前是否為遮蔽狀態
          const isMasked = input.classList.contains('input-masked');
          
          if (isMasked) {
            // 切換為顯示
            input.classList.remove('input-masked');
            input.classList.add('input-visible');
          } else {
            // 切換為遮蔽
            input.classList.remove('input-visible');
            input.classList.add('input-masked');
          }

          const eyeOpen = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
          const eyeClosed = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
          newBtn.innerHTML = isMasked ? eyeOpen : eyeClosed;
        });
      }
    };

    setupToggleVisibility('toggle-link-visibility', 'translation-link');
    setupToggleVisibility('toggle-gas-visibility', 'gas-script-id');

    if (!modeSelect) return;

    // --- 核心邏輯：應用模式 ---
    const applyMode = (mode) => {
      // 1. 重置所有狀態：先隱藏所有
      if (linkWrapper) linkWrapper.style.display = 'none';
      if (gasWrapper) gasWrapper.style.display = 'none';
      if (promptDownloadBtn) promptDownloadBtn.style.display = 'none';
      if (fastModeControls) fastModeControls.style.display = 'none'; // [確保隱藏]
      
      // 清空進度文字
      if (fastModeProgress) fastModeProgress.textContent = '';
      
      localStorage.setItem('local-translation-api-active', 'false');
      localStorage.setItem('local-prompt-api-active', 'false');
      
      updateStatusDisplay('');

      // 2. 根據模式顯示對應介面
      switch (mode) {
        case 'gas':
          if (gasWrapper) { 
            gasWrapper.style.display = 'block'; 
            if (gasInput) gasInput.focus();
          }
          Logger.debug('[DEBUG]', '[UIController]', '切換至 Google Apps Script 模式');
          break;

        case 'link':
          if (linkWrapper) { 
            linkWrapper.style.display = 'block'; 
            if (linkInput) linkInput.focus();
          }
          Logger.debug('[DEBUG]', '[UIController]', '切換至自訂伺服器模式');
          break;

        case 'fast': // [修改] 高速翻譯模式
          if (!browserInfo.isChrome) {
            alert('高速翻訳はEdgeに対応しておりません。');
            modeSelect.value = 'link'; 
            applyMode('link');
            return;
          }
          localStorage.setItem('local-translation-api-active', 'true');
          
          // [關鍵] 顯示高速翻譯控制區塊
          if (fastModeControls) {
             fastModeControls.style.display = 'flex';
          }
          Logger.debug('[DEBUG]', '[UIController]', '切換至高速翻譯模式');
          break;

        case 'ai':
          if (!browserInfo.isChrome) {
            alert('ブラウザAI翻訳はEdgeに対応しておりません。');
            modeSelect.value = 'link'; 
            applyMode('link');
            return;
          }
          localStorage.setItem('local-prompt-api-active', 'true');
          setupPromptModelDownload();
          Logger.debug('[DEBUG]', '[UIController]', '切換至 Chrome AI 模式');
          break;
          
        default:
          modeSelect.value = 'link';
          applyMode('link');
          break;
      }
      
      Storage.save('translation-mode-selection', mode, 'Translation Mode');
    };

    // --- 初始化與監聽 ---
    const savedMode = Storage.load('translation-mode-selection') || 'link';
    
    // 檢查瀏覽器相容性
    if (!browserInfo.isChrome && (savedMode === 'fast' || savedMode === 'ai')) {
      modeSelect.value = 'link';
      applyMode('link');
    } else {
      modeSelect.value = savedMode;
      applyMode(savedMode);
    }

    // 監聽變更事件 (確保這裡有被執行)
    modeSelect.addEventListener('change', (e) => {
      applyMode(e.target.value);
    });
  };

  // 點擊 Display Panel 切換最小化模式 (不需儲存狀態)
  const setupDisplayPanelInteraction = () => {
    const displayPanel = document.getElementById('display-panel');
    const controlPanel = document.getElementById('control-panel');
    const statusPanel = document.getElementById('status-panel');

    const minimizeOption = document.getElementById('click-minimize-opt');
    if (!displayPanel || !controlPanel || !statusPanel) return;

    displayPanel.addEventListener('click', (e) => {
      if (minimizeOption && minimizeOption.value === 'false') {
        return;
      }

      // 判斷目前狀態 (以 controlPanel 是否隱藏為基準)
      const isHidden = controlPanel.style.display === 'none';

      if (isHidden) {
        // === 恢復顯示 ===
        controlPanel.style.display = 'flex';
        statusPanel.style.display = 'flex'; // status-panel CSS 定義為 flex

        // 恢復原本的高度比例 (依據 CSS :root 定義的 55%)
        displayPanel.style.setProperty('--display-panel-height', '55%');

        Logger.debug('[DEBUG]', '[UIController]', '介面狀態恢復顯示');
      } else {
        // === 隱藏 (最小化) ===
        controlPanel.style.display = 'none';
        statusPanel.style.display = 'none';

        // 擴大字幕顯示區，避免下方留白 (設為 95% 或 100%)
        displayPanel.style.setProperty('--display-panel-height', '95%');

        Logger.debug('[DEBUG]', '[UIController]', '介面狀態隱藏 (最小化)');
      }
    });
  };

  // 重置所有設定
  const setupResetButton = (handlers) => {
    const resetButton = document.getElementById('reset-settings');
    if (resetButton) {
      resetButton.addEventListener('click', (e) => {
        e.stopPropagation();

        // 重置所有處理器
        Object.values(handlers).flat().forEach(handler => {
          if (handler.reset) handler.reset();
        });
      });
    }
  };

  // 主初始化
  await loadLanguageConfig();
  const handlers = initializeSettings();
  setupPanelSwitching();
  setupResetButton(handlers);

  await setupLanguagePackButton('source-language', updateStatusDisplay);

  setupPromptModelDownload();
  monitorLocalTranslationAPI();

  setupDisplayPanelInteraction();
  setupTranslationModeHandler();

  setupMicPrivacyHandler();

  const defaultTab = document.getElementById('Subtitle');
  if (defaultTab) {
    Logger.debug('[DEBUG]', '[UIController]', '預設開啟字幕設定面板');
    defaultTab.click();
  }
});