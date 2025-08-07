/**
 * 語音捕獲系統 - 重構版本
 * 
 * 主要功能：
 * 1. 語音辨識管理 - 處理瀏覽器語音 API 的啟動、停止、重啟
 * 2. 文字處理 - 關鍵字替換、格式化、長度控制
 * 3. DOM 更新 - 管理頁面元素的顯示更新
 * 4. 瀏覽器相容 - 處理不同瀏覽器的差異
 * 
 * 架構設計：
 * - BrowserDetector: 瀏覽器檢測和相容性處理
 * - ConfigManager: 統一的配置管理
 * - TextProcessor: 文字處理和關鍵字替換
 * - SpeechUIManager: DOM 操作和 UI 更新
 * - SpeechRecognitionManager: 語音辨識核心邏輯
 * - SpeechController: 主控制器，整合所有功能
 */

import { sendTranslationRequest } from './translationController.js';

// ==================== 配置管理模組 ====================

/**
 * 配置管理器
 * 職責：統一管理所有配置參數、常數和規則
 * 避免硬編碼散布在各處，便於維護和調整
 */
class ConfigManager {
  static CONFIG = {
    // 語音辨識相關配置
    SPEECH: {
      MAX_RESTART_ATTEMPTS: 50,        // 最大重啟嘗試次數
      RESTART_DELAY: 300,              // 重啟延遲時間(毫秒)
      MAX_ALTERNATIVES: 1,             // 語音辨識候選項數量
      DEFAULT_LANG: 'ja-JP'            // 預設語言
    },

    // 文字處理相關配置
    TEXT: {
      CHUNK_SIZE_MAP: {
        "ja": 35,
        "zh-TW": 33, 
        "es-ES": 80,
        "en-US": 80,
        "id-ID": 80,
        "vi-VN": 80,
        "th-TH": 80
      },
      DEFAULT_CHUNK_SIZE: 40,
      ALIGNMENT_SYMBOLS: {
        left: { prefix: '', suffix: '🎼' },
        center: { prefix: '🎼️', suffix: '🎼' },
        right: { prefix: '🎼', suffix: '' }
      }
    },

    // DOM 元素選擇器
    SELECTORS: {
      BUTTONS: {
        START: 'start-recording',
        STOP: 'stop-recording',
        RAY_MODE: 'raymode'
      },
      TEXT_ELEMENTS: {
        SOURCE: 'source-text',
        TARGET_1: 'target-text-1',
        TARGET_2: 'target-text-2', 
        TARGET_3: 'target-text-3'
      },
      CONTROLS: {
        SOURCE_LANGUAGE: 'source-language',
        ALIGNMENT_RADIO: 'input[name="alignment"]:checked'
      }
    },

    // 資料檔案路徑
    DATA: {
      KEYWORD_RULES: 'data/ray_mode_keywords.json'
    },

    // 除錯模式開關
    DEBUG: {
      ENABLED: true,
      LOG_SPEECH_RESULTS: false,  // 是否記錄詳細的語音辨識結果
      LOG_TEXT_PROCESSING: true   // 是否記錄文字處理過程
    }
  };

  /**
   * 獲取配置值
   * @param {string} path - 配置路徑，如 'SPEECH.MAX_RESTART_ATTEMPTS'
   * @returns {any} 配置值
   */
  static get(path) {
    return path.split('.').reduce((obj, key) => obj?.[key], this.CONFIG);
  }

  /**
   * 設置配置值（用於運行時調整）
   * @param {string} path - 配置路徑
   * @param {any} value - 新值
   */
  static set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key], this.CONFIG);
    if (target) target[lastKey] = value;
  }
}

// ==================== 日誌管理模組 ====================

/**
 * 統一日誌管理器
 * 職責：提供一致的日誌輸出格式，支援除錯模式開關
 */
class Logger {
  static debug(message, data = null) {
    if (ConfigManager.get('DEBUG.ENABLED')) {
      console.debug(`[DEBUG] [SpeechCapture] ${message}`, data || '');
    }
  }

  static info(message, data = null) {
    console.info(`[INFO] [SpeechCapture] ${message}`, data || '');
  }

  static warn(message, data = null) {
    console.warn(`[WARN] [SpeechCapture] ${message}`, data || '');
  }

  static error(message, data = null) {
    console.error(`[ERROR] [SpeechCapture] ${message}`, data || '');
  }

  /**
   * 條件性日誌輸出
   * @param {string} category - 日誌類別，如 'LOG_SPEECH_RESULTS'
   * @param {string} level - 日誌級別
   * @param {string} message - 訊息
   * @param {any} data - 資料
   */
  static conditionalLog(category, level, message, data = null) {
    if (ConfigManager.get(`DEBUG.${category}`)) {
      this[level](message, data);
    }
  }
}

// ==================== 瀏覽器檢測模組 ====================

/**
 * 瀏覽器檢測器
 * 職責：檢測瀏覽器類型、功能支援，處理瀏覽器相容性差異
 * 
 * 流程：
 * 1. 分析 userAgent 字串判斷瀏覽器類型
 * 2. 檢查語音 API 支援情況
 * 3. 根據瀏覽器類型調整語音辨識參數
 */
class BrowserDetector {
  constructor() {
    this.userAgent = navigator.userAgent || '';
    this.browserInfo = this.detectBrowser();
    this.speechSupport = this.checkSpeechSupport();
  }

  /**
   * 檢測瀏覽器類型
   * @returns {Object} 瀏覽器資訊
   */
  detectBrowser() {
    if (this.userAgent.includes('Edg/')) {
      return { name: 'Edge', continuous: true };
    } else if (this.userAgent.includes('Chrome/')) {
      return { name: 'Chrome', continuous: false };
    } else if (this.userAgent.includes('Firefox/')) {
      return { name: 'Firefox', continuous: false };
    } else if (this.userAgent.includes('Safari/')) {
      return { name: 'Safari', continuous: false };
    } else {
      return { name: 'Unknown', continuous: false };
    }
  }

  /**
   * 檢查語音辨識 API 支援
   * @returns {Object} 支援資訊
   */
  checkSpeechSupport() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    return {
      isSupported: !!SpeechRecognition,
      SpeechRecognition,
      hasWebkit: !!window.webkitSpeechRecognition,
      hasNative: !!window.SpeechRecognition
    };
  }

  /**
   * 獲取語音辨識配置
   * @returns {Object} 適合當前瀏覽器的配置
   */
  getSpeechConfig() {
    return {
      continuous: this.browserInfo.continuous,
      interimResults: true,
      maxAlternatives: ConfigManager.get('SPEECH.MAX_ALTERNATIVES'),
      lang: ConfigManager.get('SPEECH.DEFAULT_LANG')
    };
  }

  /**
   * 檢查是否支援語音辨識
   * @returns {boolean} 是否支援
   */
  isSpeechSupported() {
    return this.speechSupport.isSupported && this.browserInfo.name !== 'Unknown';
  }

  /**
   * 獲取瀏覽器名稱
   * @returns {string} 瀏覽器名稱
   */
  getBrowserName() {
    return this.browserInfo.name;
  }
}

// ==================== 文字處理模組 ====================

/**
 * 文字處理器
 * 職責：處理語音辨識結果，包括關鍵字替換、長度控制、格式化
 * 
 * 流程：
 * 1. 載入關鍵字替換規則
 * 2. 根據語言和模式處理文字
 * 3. 應用長度限制和格式化
 */
class TextProcessor {
  constructor() {
    this.keywordRules = [];           // 關鍵字替換規則
    this.cachedRules = new Map();     // 按語言快取的規則
    this.isLoaded = false;            // 規則是否已載入
    this.loadPromise = null;          // 載入 Promise，避免重複載入
  }

  /**
   * 載入關鍵字替換規則
   * @returns {Promise<void>}
   */
  async loadKeywordRules() {
    // 避免重複載入
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this._loadRules();
    return this.loadPromise;
  }

  /**
   * 實際載入規則的內部方法
   * @private
   */
  async _loadRules() {
    try {
      const response = await fetch(ConfigManager.get('DATA.KEYWORD_RULES'));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      this.keywordRules = await response.json();
      this.isLoaded = true;
      Logger.info('關鍵字規則載入成功', { count: this.keywordRules.length });
      
    } catch (error) {
      Logger.error('載入關鍵字規則失敗', error);
      // 載入失敗時使用空規則，避免阻塞系統運行
      this.keywordRules = [];
      this.isLoaded = true;
    }
  }

  /**
   * 獲取指定語言的快取規則
   * @param {string} lang - 語言代碼
   * @returns {Array} 編譯後的規則陣列
   */
  getCachedRules(lang) {
    if (!this.cachedRules.has(lang)) {
      const rules = this.keywordRules
        .filter(rule => rule.lang === lang)
        .map(rule => ({
          source: new RegExp(rule.source, 'ig'),
          target: rule.target
        }));
      
      this.cachedRules.set(lang, rules);
      Logger.conditionalLog('LOG_TEXT_PROCESSING', 'debug', 
        `快取語言規則: ${lang}`, { count: rules.length });
    }
    
    return this.cachedRules.get(lang);
  }

  /**
   * 處理文字（Ray Mode 專用）
   * @param {string} text - 原始文字
   * @param {string} sourceLang - 來源語言
   * @returns {string} 處理後的文字
   */
  processText(text) {
    // 驗證輸入
    if (!text || text.trim() === '' || text.trim() === 'っ') {
      Logger.conditionalLog('LOG_TEXT_PROCESSING', 'debug', 
        '跳過無效文字', { original: text });
      return '';
    }

    // 等待規則載入完成
    if (!this.isLoaded) {
      Logger.warn('關鍵字規則尚未載入，使用原始文字');
      return text;
    }

    const sourceLang = document.getElementById(ConfigManager.get('SELECTORS.CONTROLS.SOURCE_LANGUAGE'))?.value || "ja";
    const chunkSize = ConfigManager.get('TEXT.CHUNK_SIZE_MAP')[sourceLang] || ConfigManager.get('TEXT.DEFAULT_CHUNK_SIZE');
    
    // 移除標點符號
    let result = text.replace(/[、。？,.]/g, '');

    // 應用關鍵字替換規則
    const rules = this.getCachedRules(sourceLang);
    rules.forEach(rule => {
      result = result.replace(rule.source, rule.target);
    });

    // 長度控制：超過指定長度時截取後段
    if (result.length >= chunkSize) {
      let multiple = Math.floor(result.length / chunkSize);
      const charsToRemove = multiple * chunkSize;
      result = result.substring(charsToRemove);
      
      Logger.conditionalLog('LOG_TEXT_PROCESSING', 'debug', 
        '文字長度控制', { 
          original: result.length + charsToRemove, 
          trimmed: result.length, 
          chunkSize 
        });
    }

    return result;
  }

  /**
   * 根據對齊方式格式化文字
   * @param {string} baseText - 基礎文字
   * @returns {string} 格式化後的文字
   */
  formatAlignedText(baseText) {
    const alignmentElement = document.querySelector(ConfigManager.get('SELECTORS.CONTROLS.ALIGNMENT_RADIO'));
    const alignment = alignmentElement?.value || 'left';
    const symbols = ConfigManager.get('TEXT.ALIGNMENT_SYMBOLS')[alignment];
    
    if (!symbols) {
      Logger.warn(`未知的對齊方式: ${alignment}，使用預設 left`);
      return `${baseText}🎼`;
    }

    return `${symbols.prefix}${baseText}${symbols.suffix}`;
  }

  /**
   * 驗證文字是否有效
   * @param {string} text - 待驗證文字
   * @returns {boolean} 是否有效
   */
  isValidText(text) {
    return text && text.trim() !== '' && text.trim() !== 'っ';
  }

  /**
   * 清理快取（用於記憶體管理）
   */
  clearCache() {
    this.cachedRules.clear();
    Logger.debug('文字處理快取已清理');
  }
}

// ==================== UI 管理模組 ====================

/**
 * 語音 UI 管理器
 * 職責：管理所有 DOM 操作、UI 更新、按鈕狀態控制
 * 
 * 流程：
 * 1. 快取所有需要的 DOM 元素
 * 2. 提供統一的 UI 更新介面
 * 3. 管理按鈕狀態和用戶互動
 */
class SpeechUIManager {
  constructor() {
    this.elements = new Map();        // DOM 元素快取
    this.isInitialized = false;       // 是否已初始化
    this.animationFrameId = null;     // 動畫幀 ID
  }

  /**
   * 初始化 UI 管理器，快取所有必要的 DOM 元素
   * @returns {boolean} 初始化是否成功
   */
  initialize() {
    try {
      const selectors = ConfigManager.get('SELECTORS');
      
      // 快取按鈕元素
      this.elements.set('startButton', document.getElementById(selectors.BUTTONS.START));
      this.elements.set('stopButton', document.getElementById(selectors.BUTTONS.STOP));
      this.elements.set('rayModeButton', document.getElementById(selectors.BUTTONS.RAY_MODE));
      
      // 快取文字顯示元素
      this.elements.set('sourceText', document.getElementById(selectors.TEXT_ELEMENTS.SOURCE));
      this.elements.set('targetText1', document.getElementById(selectors.TEXT_ELEMENTS.TARGET_1));
      this.elements.set('targetText2', document.getElementById(selectors.TEXT_ELEMENTS.TARGET_2));
      this.elements.set('targetText3', document.getElementById(selectors.TEXT_ELEMENTS.TARGET_3));
      
      // 快取控制元素
      this.elements.set('sourceLanguage', document.getElementById(selectors.CONTROLS.SOURCE_LANGUAGE));

      // 驗證必要元素是否存在
      const requiredElements = ['startButton', 'stopButton', 'sourceText'];
      const missingElements = requiredElements.filter(key => !this.elements.get(key));
      
      if (missingElements.length > 0) {
        Logger.error('必要的 DOM 元素未找到', { missing: missingElements });
        return false;
      }

      this.isInitialized = true;
      Logger.info('UI 管理器初始化成功');
      return true;

    } catch (error) {
      Logger.error('UI 管理器初始化失敗', error);
      return false;
    }
  }

  /**
   * 獲取快取的 DOM 元素
   * @param {string} key - 元素鍵名
   * @returns {HTMLElement|null} DOM 元素
   */
  getElement(key) {
    return this.elements.get(key);
  }

  /**
   * 檢查 Ray Mode 是否啟用
   * @returns {boolean} Ray Mode 狀態
   */
  isRayModeActive() {
    const rayModeButton = this.getElement('rayModeButton');
    return rayModeButton?.classList.contains('active') || false;
  }

  /**
   * 獲取當前選擇的來源語言
   * @returns {string} 語言代碼
   */
  getSourceLanguage() {
    const sourceLanguageElement = this.getElement('sourceLanguage');
    return sourceLanguageElement?.value || ConfigManager.get('SPEECH.DEFAULT_LANG');
  }

  /**
   * 更新原始文字顯示
   * @param {string} text - 要顯示的文字
   */
  updateSourceText(text) {
    const sourceText = this.getElement('sourceText');
    if (!sourceText) {
      Logger.error('sourceText 元素未找到');
      return;
    }

    // 避免不必要的更新
    if (text.trim().length === 0 || sourceText.textContent === text) {
      return;
    }

    // 使用 requestAnimationFrame 優化性能
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.animationFrameId = requestAnimationFrame(() => {
      sourceText.textContent = text;
      sourceText.dataset.stroke = text;
      
      // 觸發重繪以確保 CSS 動畫效果
      sourceText.style.display = 'inline-block';
      sourceText.offsetHeight; // 強制重繪
      sourceText.style.display = '';
      
      Logger.conditionalLog('LOG_TEXT_PROCESSING', 'debug', 
        '更新 sourceText 內容', { text, length: text.length });
    });
  }

  /**
   * 清空所有文字顯示元素
   */
  clearAllTextElements() {
    const textElements = [
      this.getElement('sourceText'),
      this.getElement('targetText1'),
      this.getElement('targetText2'),
      this.getElement('targetText3')
    ].filter(element => element); // 過濾掉 null 元素

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.animationFrameId = requestAnimationFrame(() => {
      textElements.forEach(element => {
        element.textContent = '';
        element.dataset.stroke = '';
        element.style.display = 'inline-block';
        element.offsetHeight; // 強制重繪
        element.style.display = '';
      });
      
      Logger.debug('已清空所有文字元素');
    });
  }

  /**
   * 設定按鈕狀態
   * @param {string} state - 狀態：'recording' | 'stopped' | 'error'
   */
  setButtonState(state) {
    const startButton = this.getElement('startButton');
    const stopButton = this.getElement('stopButton');
    
    if (!startButton || !stopButton) {
      Logger.error('按鈕元素未找到');
      return;
    }

    switch (state) {
      case 'recording':
        startButton.disabled = true;
        stopButton.disabled = false;
        Logger.debug('按鈕狀態設為錄音中');
        break;
      case 'stopped':
        startButton.disabled = false;
        stopButton.disabled = true;
        Logger.debug('按鈕狀態設為已停止');
        break;
      case 'error':
        startButton.disabled = false;
        stopButton.disabled = true;
        Logger.debug('按鈕狀態設為錯誤');
        break;
      default:
        Logger.warn(`未知的按鈕狀態: ${state}`);
    }
  }

  /**
   * 顯示錯誤訊息給用戶
   * @param {string} message - 錯誤訊息
   */
  showErrorMessage(message) {
    const sourceText = this.getElement('sourceText');
    if (sourceText) {
      sourceText.textContent = message;
      sourceText.dataset.stroke = message;
    }
    
    // 也可以在這裡整合 toast 通知或其他 UI 組件
    Logger.info('顯示用戶錯誤訊息', { message });
  }

  /**
   * 綁定按鈕事件
   * @param {Function} onStart - 開始錄音回調
   * @param {Function} onStop - 停止錄音回調
   */
  bindButtonEvents(onStart, onStop) {
    const startButton = this.getElement('startButton');
    const stopButton = this.getElement('stopButton');

    if (startButton) {
      startButton.addEventListener('click', onStart);
    }
    if (stopButton) {
      stopButton.addEventListener('click', onStop);
    }

    Logger.debug('按鈕事件已綁定');
  }

  /**
   * 清理資源
   */
  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    this.elements.clear();
    this.isInitialized = false;
    Logger.debug('UI 管理器已清理');
  }
}

// ==================== 語音辨識狀態管理 ====================

/**
 * 語音辨識狀態管理器
 * 職責：使用狀態機模式管理語音辨識的各種狀態轉換
 */
class SpeechRecognitionState {
  static STATES = {
    IDLE: 'idle',           // 閒置狀態
    STARTING: 'starting',   // 啟動中
    ACTIVE: 'active',       // 辨識中
    STOPPING: 'stopping',   // 停止中
    RESTARTING: 'restarting', // 重啟中
    ERROR: 'error'          // 錯誤狀態
  };

  constructor() {
    this.currentState = SpeechRecognitionState.STATES.IDLE;
    this.restartAttempts = 0;
    this.isRestartPending = false;
    this.stopRequested = false;
  }

  /**
   * 狀態轉換
   * @param {string} newState - 新狀態
   */
  transition(newState) {
    const oldState = this.currentState;
    this.currentState = newState;
    Logger.debug('狀態轉換', { from: oldState, to: newState });
  }

  /**
   * 重設重啟計數器
   */
  resetRestartAttempts() {
    this.restartAttempts = 0;
  }

  /**
   * 增加重啟嘗試次數
   */
  incrementRestartAttempts() {
    this.restartAttempts++;
  }

  /**
   * 檢查是否可以重啟
   */
  canRestart() {
    return this.restartAttempts < ConfigManager.get('SPEECH.MAX_RESTART_ATTEMPTS') && 
           !this.stopRequested;
  }
}

// ==================== 語音辨識管理模組 ====================

/**
 * 語音辨識管理器
 * 職責：管理語音辨識 API、處理各種事件、自動重啟機制
 * 
 * 流程：
 * 1. 初始化語音辨識 API
 * 2. 設定事件處理器
 * 3. 管理自動重啟邏輯
 * 4. 處理辨識結果並通知其他模組
 */
class SpeechRecognitionManager {
  constructor(browserDetector, uiManager, textProcessor) {
    this.browserDetector = browserDetector;
    this.uiManager = uiManager;
    this.textProcessor = textProcessor;
    this.state = new SpeechRecognitionState();
    this.recognition = null;
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.autoRestartTimeout = null;
  }

  /**
   * 初始化語音辨識管理器
   * @returns {boolean} 初始化是否成功
   */
  initialize() {
    // 檢查瀏覽器支援
    if (!this.browserDetector.isSpeechSupported()) {
      const message = 'Your browser is not supported. Please use Chrome or Edge browser.';
      Logger.error('瀏覽器不支援語音辨識', { 
        browser: this.browserDetector.getBrowserName(),
        supported: this.browserDetector.isSpeechSupported()
      });
      alert(message);
      return false;
    }

    try {
      // 建立語音辨識實例
      const { SpeechRecognition } = this.browserDetector.speechSupport;
      this.recognition = new SpeechRecognition();
      
      // 設定語音辨識參數
      const config = this.browserDetector.getSpeechConfig();
      Object.assign(this.recognition, config);
      
      // 綁定事件處理器
      this.bindRecognitionEvents();
      
      Logger.info('語音辨識管理器初始化成功', { 
        browser: this.browserDetector.getBrowserName(),
        config 
      });
      
      return true;

    } catch (error) {
      Logger.error('語音辨識管理器初始化失敗', error);
      return false;
    }
  }

  /**
   * 綁定語音辨識事件處理器
   * @private
   */
  bindRecognitionEvents() {
    // 辨識結果事件
    this.recognition.onresult = (event) => {
      this.handleRecognitionResult(event);
    };

    // 辨識結束事件
    this.recognition.onend = () => {
      this.handleRecognitionEnd();
    };

    // 錯誤事件
    this.recognition.onerror = (event) => {
      this.handleRecognitionError(event);
    };

    // 無匹配結果事件
    this.recognition.onnomatch = (event) => {
      Logger.warn('無語音匹配結果', {
        finalTranscript: this.finalTranscript,
        interimTranscript: this.interimTranscript
      });
    };

    // 開始事件
    this.recognition.onstart = () => {
      this.state.transition(SpeechRecognitionState.STATES.ACTIVE);
      Logger.info('語音辨識已開始');
    };
  }

  /**
   * 處理語音辨識結果
   * @param {SpeechRecognitionEvent} event - 辨識事件
   * @private
   */
  handleRecognitionResult(event) {
    let hasFinalResult = false;
    this.interimTranscript = '';
    this.finalTranscript = '';

    // 參考 Chrome Web Speech API 的 demo 寫法
    // 由瀏覽器 API 判斷何時產出最終結果並發送翻譯
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      
      Logger.conditionalLog('LOG_SPEECH_RESULTS', 'debug', 
        '語音辨識結果', { 
          transcript, 
          isFinal: event.results[i].isFinal,
          confidence: event.results[i][0].confidence 
        });

      if (event.results[i].isFinal) {
        this.finalTranscript += transcript;
        hasFinalResult = true;
      } else {
        this.interimTranscript += transcript;
      }
    }

    // 當有最終結果時發送翻譯請求
    if (hasFinalResult && this.textProcessor.isValidText(this.finalTranscript.trim())) {
      Logger.info('最終辨識結果', { 
        text: this.finalTranscript.trim(), 
        length: this.finalTranscript.trim().length 
      });
      
      // 發送翻譯請求
      sendTranslationRequest(
        this.finalTranscript.trim(), 
        this.recognition.lang, 
        this.browserDetector.getBrowserName()
      );
    }

    // 更新 UI 顯示
    this.updateDisplay(hasFinalResult);
  }

  /**
   * 更新文字顯示
   * @param {boolean} hasFinalResult - 是否有最終結果
   * @private
   */
  updateDisplay(hasFinalResult) {
    const fullText = this.finalTranscript + this.interimTranscript;
    const isRayModeActive = this.uiManager.isRayModeActive();

    let textToUpdate;
    if (isRayModeActive) {
      if (hasFinalResult) {
        // Ray Mode 下的最終文字，使用專用過濾函數
        textToUpdate = this.textProcessor.processText(fullText);
      } else {
        // Ray Mode 下的臨時文字，加入邊緣字符和過濾
        textToUpdate = this.textProcessor.formatAlignedText(
          this.textProcessor.processText(fullText)
        );
      }
    } else {
      // 非 Ray Mode 下直接顯示原始文字
      textToUpdate = fullText;
    }

    this.uiManager.updateSourceText(textToUpdate);
  }

  /**
   * 處理語音辨識結束事件
   * @private
   */
  handleRecognitionEnd() {
    Logger.debug('語音辨識結束事件觸發', { 
      finalLength: this.finalTranscript.trim().length,
      state: this.state.currentState 
    });

    if (this.state.currentState === SpeechRecognitionState.STATES.ACTIVE) {
      this.state.transition(SpeechRecognitionState.STATES.IDLE);
      this.scheduleAutoRestart();
    }
  }

  /**
   * 處理語音辨識錯誤事件
   * @param {SpeechRecognitionErrorEvent} event - 錯誤事件
   * @private
   */
  handleRecognitionError(event) {
    Logger.error('語音辨識錯誤', { 
      error: event.error, 
      message: event.message 
    });

    this.state.transition(SpeechRecognitionState.STATES.ERROR);
    
    // 根據錯誤類型決定處理方式
    switch (event.error) {
      case 'no-speech':
      case 'audio-capture':
        Logger.warn('音訊問題，嘗試重新啟動');
        this.scheduleAutoRestart();
        break;
      case 'not-allowed':
        this.uiManager.showErrorMessage('Microphone access denied. Please allow microphone access.');
        this.uiManager.setButtonState('error');
        break;
      case 'network':
        Logger.warn('網路問題，嘗試重新啟動');
        this.scheduleAutoRestart();
        break;
      default:
        this.scheduleAutoRestart();
    }
  }

  /**
   * 安排自動重啟
   * @private
   */
  scheduleAutoRestart() {
    // 清除現有的重啟計時器
    if (this.autoRestartTimeout) {
      clearTimeout(this.autoRestartTimeout);
      this.autoRestartTimeout = null;
    }

    if (!this.state.canRestart()) {
      Logger.debug('自動重啟取消', {
        stopRequested: this.state.stopRequested,
        restartAttempts: this.state.restartAttempts,
        maxAttempts: ConfigManager.get('SPEECH.MAX_RESTART_ATTEMPTS')
      });

      if (this.state.restartAttempts >= ConfigManager.get('SPEECH.MAX_RESTART_ATTEMPTS')) {
        this.uiManager.showErrorMessage('Failed to restart speech recognition. Please check your network or microphone.');
        this.uiManager.setButtonState('error');
      }
      return;
    }

    this.state.isRestartPending = true;
    this.state.transition(SpeechRecognitionState.STATES.RESTARTING);

    // 停止當前辨識
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (error) {
        Logger.warn('停止語音辨識時發生錯誤', error);
      }
    }

    // 延遲重啟
    this.autoRestartTimeout = setTimeout(() => {
      this.performAutoRestart();
    }, ConfigManager.get('SPEECH.RESTART_DELAY'));
  }

  /**
   * 執行自動重啟
   * @private
   */
  performAutoRestart() {
    if (!this.state.isRestartPending) {
      return;
    }

    Logger.debug('準備自動重啟語音辨識');

    try {
      this.recognition.start();
      this.state.isRestartPending = false;
      this.state.resetRestartAttempts();
      this.state.transition(SpeechRecognitionState.STATES.ACTIVE);
      
      Logger.info('自動重啟語音辨識成功');

    } catch (error) {
      this.state.incrementRestartAttempts();
      Logger.error('自動重啟失敗', { 
        error: error.message, 
        attempts: this.state.restartAttempts 
      });

      // 如果還能重試，再次安排重啟
      if (this.state.canRestart()) {
        this.autoRestartTimeout = setTimeout(() => {
          this.performAutoRestart();
        }, ConfigManager.get('SPEECH.RESTART_DELAY'));
      } else {
        this.uiManager.showErrorMessage('Unable to restart speech recognition after multiple attempts.');
        this.uiManager.setButtonState('error');
      }
    }
  }

  /**
   * 開始語音辨識
   * @param {string} language - 語言代碼
   * @returns {boolean} 是否成功開始
   */
  start(language = null) {
    if (this.state.currentState === SpeechRecognitionState.STATES.ACTIVE) {
      Logger.warn('語音辨識已在運行中');
      return false;
    }

    try {
      // 清除所有顯示元素
      this.uiManager.clearAllTextElements();
      
      // 設定語言
      if (language) {
        this.recognition.lang = language;
      }
      
      // 重置狀態
      this.state.stopRequested = false;
      this.state.resetRestartAttempts();
      this.finalTranscript = '';
      this.interimTranscript = '';
      
      // 啟動辨識
      this.state.transition(SpeechRecognitionState.STATES.STARTING);
      this.recognition.start();
      
      Logger.info('語音辨識啟動', { 
        language: this.recognition.lang,
        browser: this.browserDetector.getBrowserName()
      });
      
      return true;

    } catch (error) {
      Logger.error('啟動語音辨識失敗', error);
      this.state.transition(SpeechRecognitionState.STATES.ERROR);
      return false;
    }
  }

  /**
   * 停止語音辨識
   */
  stop() {
    this.state.stopRequested = true;
    this.state.transition(SpeechRecognitionState.STATES.STOPPING);
    
    // 清除重啟計時器
    if (this.autoRestartTimeout) {
      clearTimeout(this.autoRestartTimeout);
      this.autoRestartTimeout = null;
    }

    try {
      if (this.recognition) {
        this.recognition.stop();
      }
      
      Logger.info('語音辨識已停止');
      
    } catch (error) {
      Logger.warn('停止語音辨識時發生錯誤', error);
    } finally {
      this.state.transition(SpeechRecognitionState.STATES.IDLE);
    }
  }

  /**
   * 獲取當前狀態資訊
   * @returns {Object} 狀態資訊
   */
  getStatus() {
    return {
      state: this.state.currentState,
      isRecognizing: this.state.currentState === SpeechRecognitionState.STATES.ACTIVE,
      restartAttempts: this.state.restartAttempts,
      language: this.recognition?.lang,
      isSupported: this.browserDetector.isSpeechSupported()
    };
  }

  /**
   * 清理資源
   */
  destroy() {
    this.stop();
    
    if (this.autoRestartTimeout) {
      clearTimeout(this.autoRestartTimeout);
      this.autoRestartTimeout = null;
    }

    if (this.recognition) {
      // 移除事件監聽器
      this.recognition.onresult = null;
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onnomatch = null;
      this.recognition.onstart = null;
      this.recognition = null;
    }

    Logger.debug('語音辨識管理器已清理');
  }
}

// ==================== 主控制器 ====================

/**
 * 語音控制器 - 主控制器
 * 職責：整合所有模組，提供統一的對外介面，管理整個系統的生命週期
 * 
 * 系統流程：
 * 1. 初始化階段：載入配置、檢測瀏覽器、初始化各個模組
 * 2. 運行階段：處理用戶操作、管理語音辨識、更新 UI
 * 3. 清理階段：釋放資源、清理事件監聽器
 */
class SpeechController {
  constructor() {
    // 核心模組
    this.browserDetector = null;
    this.textProcessor = null;
    this.uiManager = null;
    this.recognitionManager = null;
    
    // 初始化狀態
    this.isInitialized = false;
    this.initializationPromise = null;
  }

  /**
   * 初始化語音控制器
   * @returns {Promise<boolean>} 初始化是否成功
   */
  async initialize() {
    // 避免重複初始化
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._performInitialization();
    return this.initializationPromise;
  }

  /**
   * 執行實際的初始化邏輯
   * @private
   */
  async _performInitialization() {
    try {
      Logger.info('開始初始化語音控制器');

      // 1. 初始化瀏覽器檢測器
      this.browserDetector = new BrowserDetector();
      
      // 2. 初始化文字處理器並載入規則
      this.textProcessor = new TextProcessor();
      await this.textProcessor.loadKeywordRules();
      
      // 3. 初始化 UI 管理器
      this.uiManager = new SpeechUIManager();
      if (!this.uiManager.initialize()) {
        throw new Error('UI 管理器初始化失敗');
      }

      // 4. 初始化語音辨識管理器
      this.recognitionManager = new SpeechRecognitionManager(
        this.browserDetector,
        this.uiManager,
        this.textProcessor
      );
      
      if (!this.recognitionManager.initialize()) {
        throw new Error('語音辨識管理器初始化失敗');
      }

      // 5. 綁定 UI 事件
      this.bindUIEvents();

      this.isInitialized = true;
      Logger.info('語音控制器初始化成功', {
        browser: this.browserDetector.getBrowserName(),
        speechSupported: this.browserDetector.isSpeechSupported()
      });

      return true;

    } catch (error) {
      Logger.error('語音控制器初始化失敗', error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 綁定 UI 事件處理器
   * @private
   */
  bindUIEvents() {
    this.uiManager.bindButtonEvents(
      () => this.handleStartRecording(),
      () => this.handleStopRecording()
    );

    Logger.debug('UI 事件已綁定');
  }

  /**
   * 處理開始錄音事件
   * @private
   */
  handleStartRecording() {
    Logger.debug('用戶點擊開始錄音');

    const selectedLang = this.uiManager.getSourceLanguage();
    
    if (this.recognitionManager.start(selectedLang)) {
      this.uiManager.setButtonState('recording');
      Logger.info('開始錄音成功', { language: selectedLang });
    } else {
      this.uiManager.setButtonState('error');
      this.uiManager.showErrorMessage('Failed to start speech recognition. Please try again.');
      Logger.error('開始錄音失敗');
    }
  }

  /**
   * 處理停止錄音事件
   * @private
   */
  handleStopRecording() {
    Logger.debug('用戶點擊停止錄音');

    this.recognitionManager.stop();
    this.uiManager.setButtonState('stopped');
    Logger.info('停止錄音');
  }

  /**
   * 獲取系統狀態
   * @returns {Object} 系統狀態資訊
   */
  getStatus() {
    if (!this.isInitialized) {
      return {
        initialized: false,
        error: '系統尚未初始化'
      };
    }

    return {
      initialized: true,
      browser: this.browserDetector.getBrowserName(),
      speechRecognition: this.recognitionManager.getStatus(),
      uiReady: this.uiManager.isInitialized,
      textProcessor: {
        rulesLoaded: this.textProcessor.isLoaded,
        cacheSize: this.textProcessor.cachedRules.size
      }
    };
  }

  /**
   * 手動觸發開始錄音（供外部調用）
   * @param {string} language - 可選的語言設定
   * @returns {boolean} 是否成功開始
   */
  async startRecording(language = null) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.recognitionManager.start(language);
  }

  /**
   * 手動觸發停止錄音（供外部調用）
   */
  stopRecording() {
    if (this.recognitionManager) {
      this.recognitionManager.stop();
    }
  }

  /**
   * 更新配置（動態配置更新）
   * @param {string} path - 配置路徑
   * @param {any} value - 新值
   */
  updateConfig(path, value) {
    ConfigManager.set(path, value);
    Logger.info('配置已更新', { path, value });
  }

  /**
   * 清理資源
   */
  destroy() {
    Logger.info('開始清理語音控制器');

    if (this.recognitionManager) {
      this.recognitionManager.destroy();
      this.recognitionManager = null;
    }

    if (this.uiManager) {
      this.uiManager.destroy();
      this.uiManager = null;
    }

    if (this.textProcessor) {
      this.textProcessor.clearCache();
      this.textProcessor = null;
    }

    this.browserDetector = null;
    this.isInitialized = false;
    this.initializationPromise = null;

    Logger.info('語音控制器清理完成');
  }
}

// ==================== 模組導出和初始化 ====================

// 建立單例控制器
const speechController = new SpeechController();

/**
 * DOM 載入完成後自動初始化
 */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    Logger.info('DOM 載入完成，開始初始化語音系統');
    const success = await speechController.initialize();
    
    if (success) {
      Logger.info('語音系統初始化成功');
    } else {
      Logger.error('語音系統初始化失敗');
    }
  } catch (error) {
    Logger.error('語音系統初始化過程中發生未預期的錯誤', error);
  }
});

/**
 * 頁面卸載時清理資源
 */
window.addEventListener('beforeunload', () => {
  speechController.destroy();
});

// ==================== 公開 API ====================

/**
 * 導出模組和 API
 * 提供向下相容的介面和新的功能介面
 */

// 向下相容的導出（保持原有介面）
export { 
  speechController as default,
  ConfigManager,
  Logger
};

// 新的功能性導出
export const keywordRules = () => speechController.textProcessor?.keywordRules || [];
export const chunkSizeMap = ConfigManager.get('TEXT.CHUNK_SIZE_MAP');

// 公開 API 函數
export const getSpeechStatus = () => speechController.getStatus();
export const startSpeechRecognition = (language) => speechController.startRecording(language);
export const stopSpeechRecognition = () => speechController.stopRecording();
export const updateSpeechConfig = (path, value) => speechController.updateConfig(path, value);

/**
 * 開發者工具支援
 * 在開發模式下將控制器附加到 window 物件以便除錯
 */
if (ConfigManager.get('DEBUG.ENABLED') && typeof window !== 'undefined') {
  window.speechController = speechController;
  window.speechConfig = ConfigManager;
  Logger.info('開發者工具已啟用', { 
    message: '可使用 window.speechController 和 window.speechConfig 進行除錯' 
  });
}