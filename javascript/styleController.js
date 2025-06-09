// ==========================================================================
// 全局預設值與語言清單
// ==========================================================================
const SELECTORS = {
  scrollContainer: '.scroll-container',
  textOverlay: '.text-overlay',
  sourceText: '.source-text',
  targetText1: '.target-text-1',
  targetText2: '.target-text-2',
  targetText3: '.target-text-3',
  rightPanel: '.right-panel',
  leftPanel: '.left-panel'
};
const DEFAULT_LANGUAGES = {
  "source-language": "ja",
  "target-language1": "none",
  "target-language2": "none",
  "target-language3": "none"
};
const DEFAULT_SETTINGS = {
  "source-language": {
    fontSize: 24,
    textStrokeSize: 5,
    textColor: "#FFFFFF",
    textStrokeColor: "#B46EFF"
  },
  "target-language1": {
    fontSize: 24,
    textStrokeSize: 5,
    textColor: "#FFFFFF",
    textStrokeColor: "#800080"
  },
  "target-language2": {
    fontSize: 24,
    textStrokeSize: 5,
    textColor: "#FFFFFF",
    textStrokeColor: "#FF0000"
  },
  "target-language3": {
    fontSize: 24,
    textStrokeSize: 5,
    textColor: "#FFFFFF",
    textStrokeColor: "#8D5524"
  },
  textAlignment: "left",
  textTruncateMode: "truncate"
};
const LANGUAGE_OPTIONS = [{
    value: "ja",
    label: "日本語"
  },
  {
    value: "zh-TW",
    label: "台湾繁體"
  },
  {
    value: "en",
    label: "英語"
  },
  {
    value: "es",
    label: "スペイン語"
  },
  {
    value: "id",
    label: "インドネシア語"
  }
];

// ==========================================================================
// 輔助用
// ==========================================================================
let elements = {};
const languageToSpanMap = {
  "source-language": SELECTORS.sourceText,
  "target-language1": SELECTORS.targetText1,
  "target-language2": SELECTORS.targetText2,
  "target-language3": SELECTORS.targetText3
};

document.addEventListener("DOMContentLoaded", () => {
  
  // ==========================================================================
  // 初始化變數
  // ==========================================================================
  const languageSelectIds = ["source-language", "target-language1", "target-language2", "target-language3"];
  const ELEMENT_IDS = {
    apiKeyInput: "api-key-input",
    apiKeyValue: "api-key-value",
    toggleVisibilityUrl: "toggle-visibility-url",
    toggleVisibilityKey: "toggle-visibility-key",
    startSpeechButton: "start-recording",
    stopSpeechButton: "stop-recording",
    optionSelector: "option-language-selector",
    fontSizeSlider: "font-size-slider",
    textStrokeSlider: "text-stroke-slider",
    textColorPicker: "text-color-picker",
    textStrokeColorPicker: "text-stroke-color-picker",
    backgroundColorPicker: "background-color-picker",
    rightPanel: null,
    leftPanel: null,
    section: "section-1",
    textAlignmentSelector: "text-alignment-selector",
    textTruncateModeSelector: "text-truncate-mode",
    apiKeyInput: "api-key-input",
    apiKeyValue: "api-key-value",
    toggleAdvancedSettings: "toggle-advanced-settings",
    apiMode: "api-mode",
    apiHint: "api-hint"
  };
  elements = Object.entries(ELEMENT_IDS).reduce((obj, [key, id]) => {
    if (id) {
      obj[key] = document.getElementById(id);
      if (!obj[key]) console.warn(`Element not found: #${id}`);
    }
    return obj;
  }, {});
  elements.rightPanel = document.querySelector(SELECTORS.rightPanel);
  if (!elements.rightPanel) console.warn(`Element not found: ${SELECTORS.rightPanel}`);
  elements.leftPanel = document.querySelector(SELECTORS.leftPanel);
  if (!elements.leftPanel) console.warn(`Element not found: ${SELECTORS.leftPanel}`);
  
  // ==========================================================================
  // 動態生成語言選擇器選項
  // ==========================================================================
  languageSelectIds.forEach(id => {
    const selectElement = document.getElementById(id);
    if (!selectElement) {
      return console.error(`Language select not found: ${id}`);
    }
    const prefix = id === "source-language" ? "來源:" : `言語${id.slice(-1)}:`;
    LANGUAGE_OPTIONS.forEach(option => {
      const optionElement = document.createElement("option");
      optionElement.value = option.value;
      optionElement.textContent = `${prefix}${option.label}`;
      selectElement.appendChild(optionElement);
    });
    const savedValue = localStorage.getItem(id);
    selectElement.value = savedValue || DEFAULT_LANGUAGES[id];
    selectElement.addEventListener("change", () => {
      localStorage.setItem(id, selectElement.value);
      if (elements.optionSelector.value === id) {
        loadSettings(id);
      }
    });
  });
  
  // ==========================================================================
  // 輸入框遮蔽功能
  // ==========================================================================
  bindPasswordInput(elements.apiKeyInput, elements.toggleVisibilityUrl, 'api-key-input');
  bindPasswordInput(elements.apiKeyValue, elements.toggleVisibilityKey, 'api-key-value');
  
  // ==========================================================================
  // 樣式控制功能
  // ==========================================================================
  bindColorPicker(elements.textColorPicker, "text-color", (value) => {
    updateSectionStyle("color", value);
  });
  bindColorPicker(elements.textStrokeColorPicker, "stroke-color", (value) => {
    updateSectionStyle("--stroke-color", value);
  });
  
  bindColorPicker(elements.backgroundColorPicker, "background-color", (value) => {
    document.documentElement.style.setProperty('--right-panel-bg', value);
    elements.rightPanel.style.backgroundColor = null;
    elements.section.style.backgroundColor = null;
    console.log("rightPanel", getComputedStyle(elements.rightPanel).backgroundColor);
    console.log("section", getComputedStyle(elements.section).backgroundColor);
  }, false, true);
  
  bindSlider(elements.fontSizeSlider, "font-size", "fontSize");
  bindSlider(elements.textStrokeSlider, "stroke-size", "--stroke-width");
  
  // ==========================================================================
  // 文字截斷模式選擇器
  // ==========================================================================
  if (elements.textTruncateModeSelector) {
    const savedMode = localStorage.getItem("text-truncate-mode") || DEFAULT_SETTINGS.textTruncateMode;
    elements.textTruncateModeSelector.value = savedMode;
    updateTruncateModeClass(savedMode);
    elements.textTruncateModeSelector.addEventListener("change", e => {
      const mode = e.target.value;
      localStorage.setItem("text-truncate-mode", mode);
      updateTruncateModeClass(mode);
    });
  }
  
  // ==========================================================================
  // 選項選擇器與設定載入
  // ==========================================================================
  if (elements.optionSelector) {
    const savedOption = localStorage.getItem("selected-option-language") || elements.optionSelector.value;
    elements.optionSelector.value = savedOption;
    localStorage.setItem("selected-option-language", savedOption);
    elements.optionSelector.addEventListener("change", e => {
      const language = e.target.value;
      localStorage.setItem("selected-option-language", language);
      loadSettings(language);
    });
  }
  
  // ==========================================================================
  // 文字對齊選單初始化與功能
  // ==========================================================================
  if (elements.textAlignmentSelector) {
    const savedAlignment = localStorage.getItem("text-alignment") || DEFAULT_SETTINGS.textAlignment;
    elements.textAlignmentSelector.value = savedAlignment;
    applyTextAlignment(savedAlignment);
    elements.textAlignmentSelector.addEventListener("change", e => {
      const alignment = e.target.value;
      localStorage.setItem("text-alignment", alignment);
      applyTextAlignment(alignment);
    });
  }

  // ==========================================================================
  // 進階設定切換功能
  // ==========================================================================
  if (elements.toggleAdvancedSettings) {
    let isAdvancedMode = localStorage.getItem('settings-mode') === 'advanced';
    
    function toggleSettingsMode() {
      isAdvancedMode = !isAdvancedMode;
      localStorage.setItem('settings-mode', isAdvancedMode ? 'advanced' : 'basic');
      
      // 從 data-* 屬性讀取文字
      const advancedText = elements.toggleAdvancedSettings.getAttribute('data-advanced-text') || '詳細設定';
      const basicText = elements.toggleAdvancedSettings.getAttribute('data-basic-text') || '基本設定';
      elements.toggleAdvancedSettings.textContent = isAdvancedMode ? basicText : advancedText;
      
      // 切換 dropdown-group 內容顯示
      const dropdownGroup = document.querySelector('.dropdown-group');
      if (!dropdownGroup) {
        console.error('[StyleController] dropdown-group not found');
        return;
      }
      // 選擇語言選單，排除 api-mode
      const languageSelects = dropdownGroup.querySelectorAll('select.dropdown-style:not(#api-mode)');
      const apiModeSelect = document.getElementById('api-mode');
      const apiHint = document.getElementById('api-hint');
      
      if (isAdvancedMode) {
        languageSelects.forEach(select => select.style.display = 'none');
        if (apiModeSelect) apiModeSelect.style.display = 'block';
        if (apiHint) apiHint.style.display = 'block';
      } else {
        languageSelects.forEach(select => select.style.display = '');
        if (apiModeSelect) apiModeSelect.style.display = 'none';
        if (apiHint) apiHint.style.display = 'none';
      }
      
      logInfo(`[StyleController] 設定模式切換至：${isAdvancedMode ? '進階' : '基本'}`);
    }
    
    // 初始化按鈕文字與顯示狀態
    const initialText = isAdvancedMode
      ? (elements.toggleAdvancedSettings.getAttribute('data-basic-text') || '基本設定')
      : (elements.toggleAdvancedSettings.getAttribute('data-advanced-text') || '詳細設定');
    elements.toggleAdvancedSettings.textContent = initialText;
    
    // 初始化 dropdown-group 顯示
    const dropdownGroup = document.querySelector('.dropdown-group');
    if (dropdownGroup) {
      const languageSelects = dropdownGroup.querySelectorAll('select.dropdown-style:not(#api-mode)');
      const apiModeSelect = document.getElementById('api-mode');
      const apiHint = document.getElementById('api-hint');
      if (isAdvancedMode) {
        languageSelects.forEach(select => select.style.display = 'none');
        if (apiModeSelect) apiModeSelect.style.display = 'block';
        if (apiHint) apiHint.style.display = 'block';
      } else {
        languageSelects.forEach(select => select.style.display = '');
        if (apiModeSelect) apiModeSelect.style.display = 'none';
        if (apiHint) apiHint.style.display = 'none';
      }
    } else {
      console.error('[StyleController] 初始化時找不到 dropdown-group');
    }
    
    elements.toggleAdvancedSettings.addEventListener('click', () => {
      toggleSettingsMode();
      elements.toggleAdvancedSettings.classList.add('pressed');
      setTimeout(() => elements.toggleAdvancedSettings.classList.remove('pressed'), 200);
    });
  }

  // 勾選框控制 OpenAI API Key 輸入
  if (elements.apiMode) {
    const serviceUrlInput = elements.apiKeyInput; // 後端服務 URL
    const apiKeyInput = elements.apiKeyValue;    // API Key
    const apiHint = elements.apiHint;           // 提示文字
    if (!serviceUrlInput || !apiKeyInput || !apiHint) {
      console.warn('[StyleController] service-url-input, api-key-input, or api-hint not found');
    } else {
      // 從 localStorage 讀取 API 模式，預設 backend
      const savedApiMode = localStorage.getItem('api-mode') || 'backend';
      elements.apiMode.value = savedApiMode;
      // 初始輸入框狀態
      serviceUrlInput.disabled = savedApiMode !== 'backend';
      apiKeyInput.disabled = false; // 兩模式均需 API Key
      apiHint.textContent = savedApiMode === 'openai'
        ? '請輸入 OpenAI API Key'
        : '請輸入後端服務 URL 和驗證 Key';
      apiHint.classList.remove('error');
  
      // 監聽 API 模式變化
      elements.apiMode.addEventListener('change', () => {
        const apiMode = elements.apiMode.value;
        localStorage.setItem('api-mode', apiMode);
        serviceUrlInput.disabled = apiMode !== 'backend';
        apiKeyInput.disabled = false;
        apiHint.textContent = apiMode === 'openai'
          ? '請輸入 OpenAI API Key'
          : '請輸入後端服務 URL 和驗證 Key';
        apiHint.classList.remove('error');
        logInfo(`[StyleController] API 模式切換至：${apiMode}`);
      });
    }
  }

  // ==========================================================================
  // 全螢幕切換功能（無翻頁效果）
  // ==========================================================================
  if (elements.rightPanel) {
    elements.rightPanel.addEventListener("click", (e) => {
      if (elements.rightPanel.contains(e.target)) toggleFullscreen();
    });
  }
  
  // ==========================================================================
  // 恢復預設值按鈕
  // ==========================================================================
  const resetButton = document.getElementById("reset-settings");
  if (resetButton) {
    resetButton.addEventListener("click", resetAllSettings);
  }
  
  // ==========================================================================
  // 輔助函數
  // ==========================================================================
  function rgbToHex(rgb) {
    const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!match) return '#00FF00'; // 後備值
    const [, r, g, b] = match;
    return `#${[r, g, b].map(x => parseInt(x).toString(16).padStart(2, '0')).join('')}`;
  }

  function toggleFullscreen() {
    const isFs = elements.rightPanel.classList.toggle("fullscreen");
    elements.leftPanel.classList.toggle("hidden", isFs);
    document.body.classList.toggle("no-scroll", isFs);
  }

  function resetAllSettings() {
    // 重置語言特定設定
    languageSelectIds.forEach(lang => {
      const defs = DEFAULT_SETTINGS[lang];
      localStorage.setItem(`${lang}-font-size`, defs.fontSize);
      localStorage.setItem(`${lang}-stroke-size`, defs.textStrokeSize);
      localStorage.setItem(`${lang}-text-color`, defs.textColor);
      localStorage.setItem(`${lang}-stroke-color`, defs.textStrokeColor);
    });
    // 重置背景色
    document.documentElement.style.removeProperty('--right-panel-bg');
    elements.rightPanel.style.backgroundColor = null;
    elements.section.style.backgroundColor = null;
    // 獲取 CSS 預設值
    const defaultBgColor = getComputedStyle(document.documentElement).getPropertyValue('--right-panel-bg').trim() || '#00FF00';
    const defaultBgColorHex = defaultBgColor.startsWith('#') ? defaultBgColor : rgbToHex(defaultBgColor) || '#00FF00';
    // 同步更新 localStorage 和選擇器
    localStorage.setItem('background-color', defaultBgColorHex);
    if (elements.backgroundColorPicker) {
      elements.backgroundColorPicker.value = defaultBgColorHex;
      document.documentElement.style.setProperty('--right-panel-bg', defaultBgColorHex); // 應用預設值到頁面
    }
    // 重新載入所有語言的設定
    languageSelectIds.forEach(language => {
      loadSettings(language);
    });
    // 應用文字對齊和截斷模式
    applyTextAlignment(DEFAULT_SETTINGS.textAlignment);
    updateTruncateModeClass(DEFAULT_SETTINGS.textTruncateMode);
  }

  function bindPasswordInput(inputElement, toggleElement, key) {
    if (!inputElement || !toggleElement) {
      console.error(`[StyleController] Invalid input or toggle element for ${key}`);
      return;
    }
    const saved = localStorage.getItem(key);
    if (saved) inputElement.value = saved;
    inputElement.addEventListener('input', () => {
      localStorage.setItem(key, inputElement.value);
    });
    toggleElement.addEventListener('click', () => {
      const isPassword = inputElement.type === 'password';
      inputElement.type = isPassword ? 'text' : 'password';
      toggleElement.classList.toggle('visible', isPassword);
    });
  }

  function bindColorPicker(element, key, updateCallback, isLangSpecific = true, isGlobal = false) {
    if (!element) {
      console.error(`[StyleController] Invalid element for ${key}`);
      return;
    }
    element.addEventListener("input", () => {
      const lang = isLangSpecific ? elements.optionSelector.value : "";
      console.log(`[bindColorPicker] Input for ${key}, lang: ${lang}, value: ${element.value}`);
      const value = element.value;
      updateCallback(value);
      saveSettings({
        [key]: value
      });
    });
    if (key === "background-color") {
      const savedBgColor = localStorage.getItem("background-color");
      let colorValue;
      if (savedBgColor) {
        colorValue = savedBgColor;
      }
      else {
        const defaultBgColor = getComputedStyle(document.documentElement).getPropertyValue('--right-panel-bg').trim();
        colorValue = defaultBgColor.startsWith('#') ? defaultBgColor : rgbToHex(defaultBgColor) || '#00FF00';
        localStorage.setItem("background-color", colorValue);
      }
      element.value = colorValue;
      updateCallback(colorValue);
    }
    else {
      const lang = isLangSpecific ? elements.optionSelector.value : "";
      if (!lang || !languageToSpanMap[lang]) {
        console.warn(`[bindColorPicker] Invalid language: ${lang}, defaulting to source-language`);
        elements.optionSelector.value = "source-language"; // 設置默認語言
      }
      const savedValue = localStorage.getItem(isGlobal ? key : `${lang}-${key}`) ||
        DEFAULT_SETTINGS[lang]?.[key] ||
        element.value ||
        "#FFFFFF";
      console.log(`[bindColorPicker] Initializing ${key}, lang: ${lang}, value: ${savedValue}`);
      element.value = savedValue;
      updateCallback(savedValue);
    }
  }

  function bindSlider(element, key, cssProperty) {
    if (!element) {
      console.error(`[StyleController] Invalid element for ${key}`);
      return;
    }
    element.addEventListener("input", () => {
      const value = parseFloat(element.value);
      const lang = elements.optionSelector.value;
      updateSectionStyle(cssProperty, cssProperty === "fontSize" ? `${value}px` : `${value}px`);
      saveSettings({
        [key]: value
      });
    });
    const lang = elements.optionSelector.value;
    const defaultValue = DEFAULT_SETTINGS[lang]?.[key] || (key === "font-size" ? 24 : 5);
    const savedValue = localStorage.getItem(`${lang}-${key}`) || defaultValue;
    element.value = savedValue;
    updateSectionStyle(cssProperty, cssProperty === "fontSize" ? `${savedValue}px` : `${savedValue}px`);
  }

  function updateSectionStyle(property, value) {
    const spanClass = languageToSpanMap[elements.optionSelector.value];
    const span = elements.section.querySelector(spanClass);
    if (span) {
      if (property.startsWith('--')) {
        span.style.setProperty(property, value);
      }
      else {
        span.style[property] = value;
      }
      if (!span.getAttribute("data-stroke") || span.getAttribute("data-stroke") !== span.textContent) {
        span.setAttribute("data-stroke", span.textContent);
      }
    }
    else {
      console.error(`Span not found for class: ${spanClass}`);
    }
  }

  function getNumericSetting(key, defaultVal, min, max) {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultVal;
    const n = parseFloat(raw);
    return isNaN(n) ? defaultVal : Math.min(Math.max(n, min), max);
  }

  function applySpanSettings(span, {
    fontSize,
    textColor,
    textStrokeSize,
    textStrokeColor
  }) {
    span.style.fontSize = `${fontSize}px`;
    span.style.color = textColor;
    span.style.setProperty("--stroke-width", `${textStrokeSize}px`);
    span.style.setProperty("--stroke-color", textStrokeColor);
    if (span.getAttribute("data-stroke") !== span.textContent) {
      span.setAttribute("data-stroke", span.textContent);
    }
  }

  function applyControlValues(settings, language) {
    if (elements.optionSelector.value !== language) return;
    const {
      fontSize,
      textStrokeSize,
      textColor,
      textStrokeColor,
      backgroundColor
    } = settings;
    if (elements.fontSizeSlider) elements.fontSizeSlider.value = fontSize;
    if (elements.textStrokeSlider) elements.textStrokeSlider.value = textStrokeSize;
    if (elements.textColorPicker) elements.textColorPicker.value = textColor;
    if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = textStrokeColor;
  }

  function loadSettings(language) {
    const defaults = DEFAULT_SETTINGS[language] || {};
    const settings = {
      fontSize: getNumericSetting(`${language}-font-size`, defaults.fontSize || 24, 10, 100),
      textStrokeSize: getNumericSetting(`${language}-stroke-size`, defaults.textStrokeSize || 5, 0, 25),
      textColor: localStorage.getItem(`${language}-text-color`) || defaults.textColor || "#FFFFFF",
      textStrokeColor: localStorage.getItem(`${language}-stroke-color`) || defaults.textStrokeColor || "#000000",
      backgroundColor: localStorage.getItem("background-color") || DEFAULT_SETTINGS.backgroundColor || "#00FF00"
    };
    const span = elements.section.querySelector(languageToSpanMap[language]);
    if (span) applySpanSettings(span, settings);
    applyControlValues(settings, language);
  }

  function saveSettings(settings) {
    const language = elements.optionSelector.value;
    Object.entries(settings).forEach(([key, value]) => {
      if (key === "background-color") {
        localStorage.setItem(key, value);
      }
      else {
        localStorage.setItem(`${language}-${key}`, value);
      }
    });
    refreshAllStyles();
  }

  function refreshAllStyles() {
    const section = document.getElementById("section-1");
    if (!section) return;
    const spans = {
      "source-language": section.querySelector(".source-text"),
      "target-language1": section.querySelector(".target-text-1"),
      "target-language2": section.querySelector(".target-text-2"),
      "target-language3": section.querySelector(".target-text-3")
    };
    Object.entries(spans).forEach(([lang, span]) => {
      if (span) {
        const savedFontSize = localStorage.getItem(`${lang}-font-size`);
        const savedStrokeSize = localStorage.getItem(`${lang}-stroke-size`);
        const settings = {
          fontSize: savedFontSize !== null ? parseFloat(savedFontSize) : DEFAULT_SETTINGS[lang].fontSize,
          textColor: localStorage.getItem(`${lang}-text-color`) || DEFAULT_SETTINGS[lang].textColor,
          textStrokeSize: savedStrokeSize !== null ? parseFloat(savedStrokeSize) : DEFAULT_SETTINGS[lang].textStrokeSize,
          textStrokeColor: localStorage.getItem(`${lang}-stroke-color`) || DEFAULT_SETTINGS[lang].textStrokeColor
        };
        applySpanSettings(span, settings);
      }
      updateTruncateModeClass(localStorage.getItem("text-truncate-mode") || DEFAULT_SETTINGS.textTruncateMode);
    });
  }

  function applyTextAlignment(alignment) {
    const scrollContainer = elements.section.querySelector(SELECTORS.scrollContainer);
    if (scrollContainer) {
      scrollContainer.style.textAlign = alignment;
    }
    else {
      console.error(`Scroll container not found: ${SELECTORS.scrollContainer}`);
    }
  }

  function updateTruncateModeClass(mode) {
    const scrollContainer = document.querySelector(SELECTORS.scrollContainer);
    if (scrollContainer) {
      if (mode === "truncate") {
        scrollContainer.classList.add("truncate-mode");
      }
      else {
        scrollContainer.classList.remove("truncate-mode");
      }
    }
    else {
      console.error(`Scroll container not found: ${SELECTORS.scrollContainer}`);
    }
  }
  
  // 載入所有語言的設定
  languageSelectIds.forEach(language => {
    loadSettings(language);
  });
});
