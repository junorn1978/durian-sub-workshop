import { processTranslationUrl } from './translationController.js';
import { loadLanguageConfig, getAllLanguages } from './config.js';
import { updateSourceText, sendTranslationRequest } from './speechCapture.js';
import { setupTextInputTranslation } from './textInputController.js';

document.addEventListener('DOMContentLoaded', async function() {
  
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
      { id: 'raymode', type: 'toggle', key: 'raymode-active', desc: 'Raymode active state' },
      { id: 'local-translation-api', type: 'toggle', key: 'local-translation-api-active', desc: 'local-translation-api state' }
    ],

    // 面板對應
    panels: {
      'source1': 'source-styles-panel',
      'target1': 'target1-styles-panel', 
      'target2': 'target2-styles-panel',
      'target3': 'target3-styles-panel',
      'options': 'options-panel',
      'comment': 'comment-translation',
      'usage': 'usage-guide'
    }
  };

  // 瀏覽器檢查
  const isEdge = navigator.userAgent.includes('Edg/');
  if (isEdge) {
    console.debug('[DEBUG] [UIController]', '檢測到 Edge 瀏覽器，限制本地端 API 功能');
    document.getElementById('status-display').textContent = '現在のところ、New APIはEdgeに対応しておりません。ご了承ください。';
    const apiButton = document.getElementById('local-translation-api');
    if (apiButton) {
      apiButton.disabled = true;
      apiButton.classList.remove('active');
      localStorage.removeItem('local-translation-api-active');
    }
  }

  // 通用的 localStorage 操作
  const Storage = {
    save: (key, value, desc) => {
      localStorage.setItem(key, value);
      console.debug('[DEBUG] [UIController]', `${desc} 已儲存至 localStorage: ${value}`);
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
      
      if (!radio) return;
      
      radio.checked = true;
      this.apply(saved);
    },

    apply(value) {
      const applyToTargets = (fn) => {
        config.targets.forEach(targetId => {
          const element = document.getElementById(targetId);
          if (element) fn(element, value);
        });
      };

      if (config.css) {
        applyToTargets((element, val) => element.style.setProperty(config.css, val));
        return;
      }
      
      if (config.name === 'overflow') {
        applyToTargets((element, val) => {
          element.classList.remove('overflow-normal', 'overflow-shrink', 'overflow-truncate');
          element.classList.add(`overflow-${val}`);
        });
      }
    },

    setupListener() {
      const radios = document.querySelectorAll(`input[name="${config.name}"]`);
      radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (!e.target.checked) return;
          
          this.apply(e.target.value);
          Storage.save(config.key, e.target.value, config.desc);
        });
      });
    },

    reset() {
      const radio = document.querySelector(`input[name="${config.name}"][value="${config.default}"]`);
      if (!radio) return;
      
      radio.checked = true;
      this.apply(config.default);
      Storage.save(config.key, config.default, config.desc);
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
      
      'toggle': {
        load(element) {
          if (isEdge && config.id === 'local-translation-api') {
            element.classList.remove('active');
            Storage.save(config.key, 'false', config.desc);
            return;
          }
          const saved = Storage.load(config.key) === 'true';
          element.classList.toggle('active', saved);
        },
        
        setupListener(element) {
          element.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isEdge && config.id === 'local-translation-api') {
              console.debug('[DEBUG] [UIController]', 'Edge 瀏覽器下禁止啟用本地端 API');
              return;
            }
            element.classList.toggle('active');
            const isActive = element.classList.contains('active');
            Storage.save(config.key, isActive.toString(), config.desc);
          });
        },
        
        reset(element) {
          element.classList.remove('active');
          Storage.save(config.key, 'false', config.desc);
        }
      }
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

      console.debug('[DEBUG] [UIController]', `已填充 ${config.id} 選單，使用 id 作為 value`);
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
        const menuButtons = document.querySelectorAll('.menu-button');
        
        if (!translationLink) return;
        
        apiLinkButton.classList.toggle('active');
        menuButtons.forEach(btn => btn.style.display = isActive ? 'inline-block' : 'none');
        translationLink.style.display = isActive ? 'none' : 'inline-block';
      });
    }
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

        // 確保 Edge 瀏覽器重置後仍禁用
        if (isEdge) {
          const apiButton = document.getElementById('local-translation-api');
          if (apiButton) {
            apiButton.disabled = true;
            apiButton.classList.remove('active');
            localStorage.removeItem('local-translation-api-active');
            console.debug('[DEBUG] [UIController]', '重置後確保 Edge 瀏覽器本地端 API 禁用');
          }
        }
      });
    }
  };

  // 主初始化
  await loadLanguageConfig();
  const handlers = initializeSettings();
  setupPanelSwitching();
  setupResetButton(handlers);
  setupTextInputTranslation();
});