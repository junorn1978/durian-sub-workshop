import { updateStatusDisplay } from './translationController.js';
import { loadLanguageConfig, getAllLanguages, setRayModeStatus, setForceSingleLineStatus } from './config.js';
import { setupPromptModelDownload } from './promptTranslationService.js';
import { setupLanguagePackButton } from './languagePackManager.js';
import { monitorLocalTranslationAPI } from './translatorApiService.js';
import { browserInfo } from './speechCapture.js';

document.addEventListener('DOMContentLoaded', async function() {
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
      { id: 'raymode', type: 'checkbox', key: 'raymode-active', desc: 'Raymode active state' },
      { id: 'click-minimize-opt', type: 'select', key: 'click-minimize-enabled', desc: 'Display panel click minimize' },
      { id: 'force-single-line-opt', type: 'select', key: 'force-single-line-enabled', desc: 'Force single line display' },
    ],

    // 面板對應
    panels: {
      'Subtitle': 'source-styles-panel',
      'options': 'options-panel'
    }
  };

  // 瀏覽器檢查
  if (!browserInfo.isChrome) {
    console.debug('[DEBUG] [UIController]', '檢測到 Edge 瀏覽器，限制本地端 API 功能');
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
      //console.debug('[DEBUG] [UIController]', `${desc} 已儲存至 localStorage`);
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
        
        reset() {}
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
          const defaultValue = (config.id === 'force-single-line-opt') ? 'false' : 'true'; 
          const value = saved ? saved : defaultValue;
          element.value = value;

          // [修改] 針對強制單行，直接操作 CSS Class
          if (config.id === 'force-single-line-opt') {
             const sourceText = document.getElementById('source-text');
             if (sourceText) {
               if (value === 'true') {
                 sourceText.classList.add('visual-single-line');
               } else {
                 sourceText.classList.remove('visual-single-line');
               }
             }
             // 同步變數 (雖然這在純 CSS 解法中不再重要，但保持一致性也好)
             setForceSingleLineStatus(value === 'true');
          }
        },
        
        setupListener(element) {
          element.addEventListener('change', (e) => {
            const value = e.target.value;
            Storage.save(config.key, value, config.desc);
            console.debug('[DEBUG] [UI]', `${config.desc} 設定變更: ${value}`);
            
            // [修改] 針對強制單行，直接操作 CSS Class
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
          });
        },
        
        reset(element) {
          const defaultVal = (config.id === 'force-single-line-opt') ? 'false' : 'true';
          element.value = defaultVal;
          Storage.save(config.key, defaultVal, config.desc);
          
          // [修改] 重置時移除 Class
          if (config.id === 'force-single-line-opt') {
             const sourceText = document.getElementById('source-text');
             if (sourceText) sourceText.classList.remove('visual-single-line');
             setForceSingleLineStatus(false);
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

  // 動態填充語言選單
  const populateLanguageSelects = () => {
    CONFIG.languages.forEach(config => {
      const select = document.getElementById(config.id);
      if (!select) return;

      // 清空現有選項
      select.innerHTML = config.id === 'source-language'
        ? '<option value="">言語を選択</option>'
        : '<option value="none">翻訳しない</option>';

      // 從 getAllLanguages 獲取語言列表
      const role = config.id === 'source-language' ? 'source' : 'target';
      const languages = getAllLanguages(role);
      languages.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.id; // 使用完整 id (如 "ja-JP")
        option.textContent = lang.label; // 使用 label 作為顯示文字
        select.appendChild(option);
      });

      //console.debug('[DEBUG] [UIController]', `已填充 ${config.id} 選單，使用 id 作為 value`);
    });
  };
  
  // 初始化所有設定
  const initializeSettings = () => {
    // 填充語言選單
    populateLanguageSelects();
    
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
      console.debug('[DEBUG]', '[UI]', `麥克風隱私模式: ${isProtected ? '開啟' : '關閉'}`);
    };

    // 初始化：讀取上次設定
    const savedState = localStorage.getItem('mic-privacy-enabled') === 'true';
    updatePrivacyState(savedState);

    // 監聽變更
    toggle.addEventListener('change', (e) => {
      updatePrivacyState(e.target.checked);
    });
  };

// 翻譯模式下拉選單處理
  const setupTranslationModeHandler = () => {
    const modeSelect = document.getElementById('translation-mode');
    
    // [修改] 改為抓取容器，而非原本的 input
    const linkWrapper = document.getElementById('link-input-wrapper'); 
    // input 還是要抓，因為要控制 focus
    const linkInput = document.getElementById('translation-link'); 
    
    const promptDownloadBtn = document.getElementById('prompt-api-download');
    
    // [新增] 眼睛按鈕處理邏輯
    const toggleBtn = document.getElementById('toggle-link-visibility');
    if (toggleBtn && linkInput) {
      // 避免重複綁定，使用 replaceWith 克隆大法或是確保只執行一次
      const newToggleBtn = toggleBtn.cloneNode(true);
      toggleBtn.parentNode.replaceChild(newToggleBtn, toggleBtn);
      
      newToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isPassword = linkInput.type === 'password';
        
        // 1. 切換 Input 類型
        linkInput.type = isPassword ? 'text' : 'password';
        
        // 2. 切換 SVG 圖示
        // 定義 SVG path: 
        // 睜眼 (Show)
        const eyeOpen = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
        // 閉眼 (Hide) - 斜線
        const eyeClosed = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

        newToggleBtn.innerHTML = isPassword ? eyeOpen : eyeClosed;
      });
    }

    if (!modeSelect) return;

    // 定義各個模式的行為
    const applyMode = (mode) => {
      // 1. 重置所有狀態
      // [修改] 隱藏容器，而不是隱藏 input
      if (linkWrapper) linkWrapper.style.display = 'none';
      if (promptDownloadBtn) promptDownloadBtn.style.display = 'none';
      
      localStorage.setItem('local-translation-api-active', 'false');
      localStorage.setItem('local-prompt-api-active', 'false');
      
      updateStatusDisplay('');

      // 2. 根據模式執行動作
      switch (mode) {
        default:
        case 'link':
          // [修改] 顯示容器
          if (linkWrapper) { linkWrapper.style.display = 'block'; }
          if (linkInput)   { linkInput.focus(); }
          break;

        case 'fast':
          if (!browserInfo.isChrome) {
            alert('高速翻訳はEdgeに対応しておりません。');
            modeSelect.value = 'link'; 
            // [修改] 顯示容器
            if (linkWrapper) {
                linkWrapper.style.display = 'block';
                if(linkInput) linkInput.focus();
            }
             return;
          }
          localStorage.setItem('local-translation-api-active', 'true');
          console.debug('[DEBUG] [UI]', '切換至高速翻譯模式');
          break;

        case 'ai':
          if (!browserInfo.isChrome) {
            alert('ブラウザAI翻訳はEdgeに対応しておりません。');
            modeSelect.value = 'link'; 
            // [修改] 顯示容器
            if (linkWrapper) {
                linkWrapper.style.display = 'block';
                if(linkInput) linkInput.focus();
            }
             return;
          }
          localStorage.setItem('local-prompt-api-active', 'true');
          setupPromptModelDownload(); 
          //if (promptDownloadBtn) promptDownloadBtn.style.display = 'inline-block'; 
          console.debug('[DEBUG] [UI]', '切換至 Chrome AI 模式');
          break;
      }
      Storage.save('translation-mode-selection', mode, 'Translation Mode');
    };

    // ... (初始化邏輯保持不變，但注意 Edge 回退邏輯也要改 linkWrapper)
    const savedMode = Storage.load('translation-mode-selection') || 'link';
    
    if (!browserInfo.isChrome && (savedMode === 'fast')) {
      modeSelect.value = 'link';
      applyMode('link');
    } else {
      modeSelect.value = savedMode;
      applyMode(savedMode);
    }

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
        
        console.debug('[DEBUG]', '[uiController.js]', '介面狀態恢復顯示');
      } else {
        // === 隱藏 (最小化) ===
        controlPanel.style.display = 'none';
        statusPanel.style.display = 'none';
        
        // 擴大字幕顯示區，避免下方留白 (設為 95% 或 100%)
        displayPanel.style.setProperty('--display-panel-height', '95%');
        
        console.debug('[DEBUG]', '[uiController.js]', '介面狀態隱藏 (最小化)');
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
    console.debug('[DEBUG]', '[uiController.js]', '預設開啟字幕設定面板');
    defaultTab.click();
  }
});