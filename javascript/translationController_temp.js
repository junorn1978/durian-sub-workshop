// 匯入外部模組
import { keywordRules, chunkSizeMap } from './speechCapture.js';

// 常數定義
const CONFIG = {
  MAX_BUFFER_SIZE: 10,
  MAX_URL_LENGTH: 20000,
  SELECTORS: {
    RAY_MODE: 'raymode',
    TRANSLATION_LINK: 'translation-link',
    TARGET_TEXT: {
      1: 'target-text-1',
      2: 'target-text-2',
      3: 'target-text-3'
    },
    TARGET_LANGUAGE: {
      1: 'target1-language',
      2: 'target2-language',
      3: 'target3-language'
    }
  },
  DISPLAY_TIME_RULES: {
    'ja-JP': [
      { maxLength: 20, time: 1 },
      { maxLength: 40, time: 2 },
      { maxLength: Infinity, time: 3 }
    ],
    'zh-TW': [
      { maxLength: 20, time: 1 },
      { maxLength: 40, time: 2 },
      { maxLength: Infinity, time: 3 }
    ],
    'default': [
      { maxLength: 30, time: 1 },
      { maxLength: 70, time: 2 },
      { maxLength: Infinity, time: 3 }
    ]
  }
};

// 錯誤碼與自訂錯誤類別
const ERROR_CODES = {
  INVALID_TEXT: 'INVALID_TEXT',
  INVALID_URL: 'INVALID_URL',
  NETWORK_ERROR: 'NETWORK_ERROR',
  URL_TOO_LONG: 'URL_TOO_LONG'
};

class TranslationError extends Error {
  constructor(message, code = 'UNKNOWN', details = null) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.details = details;
  }
}

// 日誌管理
const Logger = {
  isDevelopment: true, // 可從環境變數設定
  debug(message, data = '') {
    if (this.isDevelopment) {
      console.debug(`[DEBUG] [Translation] ${message}`, data);
    }
  },
  info(message, data = '') {
    console.info(`[INFO] [Translation] ${message}`, data);
  },
  error(message, data = '') {
    console.error(`[ERROR] [Translation] ${message}`, data);
  }
};

// DOM 管理
const DOMManager = {
  elements: new Map(),
  cacheElements() {
    Object.entries(CONFIG.SELECTORS.TARGET_TEXT).forEach(([key, id]) => {
      this.elements.set(`targetText${key}`, document.getElementById(id));
    });
    Object.entries(CONFIG.SELECTORS.TARGET_LANGUAGE).forEach(([key, id]) => {
      this.elements.set(`targetLanguage${key}`, document.getElementById(id));
    });
    this.elements.set('rayMode', document.getElementById(CONFIG.SELECTORS.RAY_MODE));
    this.elements.set('translationLink', document.getElementById(CONFIG.SELECTORS.TRANSLATION_LINK));
  },
  getElement(key) {
    return this.elements.get(key);
  },
  isRayModeActive() {
    return this.getElement('rayMode')?.classList.contains('active') || false;
  },
  getServiceUrl() {
    return this.getElement('translationLink')?.value || '';
  },
  getTargetLanguages() {
    return [1, 2, 3]
      .map(i => this.getElement(`targetLanguage${i}`)?.value)
      .filter(lang => lang && lang !== 'none');
  },
  updateTargetText(index, text, isMultiLine) {
    const element = this.getElement(`targetText${index}`);
    if (!element) return;
    element.textContent = text;
    element.dataset.stroke = text;
    element.style.display = 'inline-block';
    element.offsetHeight; // 觸發重繪
    element.style.display = '';
    element.classList.toggle('multi-line', isMultiLine);
  }
};

// 顯示緩衝區管理
const DisplayManager = {
  displayBuffers: { target1: [], target2: [], target3: [] },
  currentDisplays: { target1: null, target2: null, target3: null },
  addToBuffer(data, targetLangs, minDisplayTime) {
    const isRayModeActive = DOMManager.isRayModeActive();
    targetLangs.forEach((lang, index) => {
      if (data.translations && data.translations[index]) {
        const filteredText = isRayModeActive ? filterTextWithKeywords(data.translations[index], lang) : data.translations[index];
        this.displayBuffers[`target${index + 1}`].push({
          text: filteredText,
          minDisplayTime,
          lang
        });
        Logger.debug('緩衝區新增:', { lang, text: filteredText, minDisplayTime });
      }
    });
  },
  processBuffers() {
    const now = Date.now();
    ['target1', 'target2', 'target3'].forEach(key => {
      const index = key.replace('target', '');
      if (this.displayBuffers[key].length > CONFIG.MAX_BUFFER_SIZE) {
        this.displayBuffers[key].shift();
        Logger.debug('緩衝區溢出，丟棄最早結果:', { key });
      }
      if (this.currentDisplays[key] && now - this.currentDisplays[key].startTime < this.currentDisplays[key].minDisplayTime * 1000) {
        return;
      }
      if (this.displayBuffers[key].length > 0) {
        const next = this.displayBuffers[key].shift();
        this.currentDisplays[key] = {
          text: next.text,
          startTime: now,
          minDisplayTime: next.minDisplayTime
        };
        const chunkSize = chunkSizeMap[next.lang] || 40;
        const isMultiLine = next.text.length > chunkSize;
        DOMManager.updateTargetText(index, next.text, isMultiLine);
        Logger.info('更新翻譯文字:', {
          lang: next.lang,
          text: next.text,
          elapsed: this.currentDisplays[key].startTime ? (now - this.currentDisplays[key].startTime) / 1000 : 0
        });
      }
    });
    animationFrameId = requestAnimationFrame(() => this.processBuffers());
  }
};

// 佇列與處理狀態
let translationQueue = [];
let isProcessing = false;
let animationFrameId = null;

// 文字過濾
function filterTextWithKeywords(text, targetLang) {
  const isRayModeActive = DOMManager.isRayModeActive();
  if (!isRayModeActive) return text;
  let result = text.replace(/"/g, '');
  const cachedRules = new Map();
  if (!cachedRules.has(targetLang)) {
    cachedRules.set(targetLang, keywordRules
      .filter(rule => rule.lang === targetLang)
      .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
  }
  cachedRules.get(targetLang).forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });
  return result;
}

// URL 驗證與準備
async function validateAndPrepareUrl(serviceUrl, serviceKey) {
  if (!serviceUrl) {
    throw new TranslationError('Service URL is empty', ERROR_CODES.INVALID_URL);
  }
  if (serviceUrl.startsWith('GAS://')) {
    const scriptId = serviceUrl.replace('GAS://', '');
    if (!/^[a-zA-Z0-9_-]+$/.test(scriptId)) {
      throw new TranslationError('Google Apps Script ID 只能包含字母、數字和連字符', ERROR_CODES.INVALID_URL);
    }
    return { url: `https://script.google.com/macros/s/${scriptId}/exec`, method: 'GET' };
  }
  const match = serviceUrl.match(/^\s*(\w+):\/\/(.+)$/);
  if (match) {
    const protocol = match[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') {
      serviceKey = match[1];
      serviceUrl = match[2];
      localStorage.setItem('api-key-value', serviceKey);
    } else {
      serviceUrl = match[2];
    }
  }
  const finalUrl = `https://${serviceUrl}/translate`;
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?\/translate$/.test(finalUrl)) {
    throw new TranslationError('Invalid URL format', ERROR_CODES.INVALID_URL);
  }
  return { url: finalUrl, method: 'POST', serviceKey };
}

// 發送翻譯請求（POST）
async function sendTranslation(text, targetLangs, serviceUrl, serviceKey) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    Logger.debug('無效文字，跳過翻譯:', text);
    return null;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (serviceKey) headers['X-API-Key'] = serviceKey;
  const payload = { text, targetLangs };
  Logger.debug('發送 POST 請求:', { text, targetLangs });
  try {
    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new TranslationError(`翻譯請求失敗: ${response.status} - ${await response.text()}`, ERROR_CODES.NETWORK_ERROR);
    }
    return await response.json();
  } catch (error) {
    throw new TranslationError(`網路請求失敗: ${error.message}`, ERROR_CODES.NETWORK_ERROR, error);
  }
}

// 發送翻譯請求（GET）
async function sendTranslationGet(text, targetLangs, sourceLang, serviceUrl) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    Logger.debug('無效文字，跳過翻譯:', text);
    return null;
  }
  if (!serviceUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/)) {
    throw new TranslationError('無效的 Google Apps Script URL', ERROR_CODES.INVALID_URL);
  }
  const queryParams = `text=${encodeURIComponent(text)}&targetLangs=${encodeURIComponent(JSON.stringify(targetLangs))}&sourceLang=${encodeURIComponent(sourceLang)}`;
  const url = `${serviceUrl}?${queryParams}`;
  if (url.length > CONFIG.MAX_URL_LENGTH) {
    throw new TranslationError('請求資料過長，請縮短文字內容', ERROR_CODES.URL_TOO_LONG);
  }
  Logger.debug('發送 GET 請求:', url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors'
    });
    if (!response.ok) {
      throw new TranslationError(`翻譯請求失敗: ${response.status} - ${await response.text()}`, ERROR_CODES.NETWORK_ERROR);
    }
    const data = await response.json();
    Logger.debug('接收 GET 回應:', data);
    return data;
  } catch (error) {
    throw new TranslationError(`網路請求失敗: ${error.message}`, ERROR_CODES.NETWORK_ERROR, error);
  }
}

// 處理翻譯 URL
async function processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, serviceKey) {
  const urlConfig = await validateAndPrepareUrl(serviceUrl, serviceKey);
  if (urlConfig.method === 'GET') {
    return await sendTranslationGet(text, targetLangs, sourceLang, urlConfig.url);
  } else {
    return await sendTranslation(text, targetLangs, urlConfig.url, urlConfig.serviceKey);
  }
}

// 處理佇列
async function processQueue() {
  if (isProcessing || translationQueue.length === 0) return;
  isProcessing = true;
  const { text, sourceLang, browser } = translationQueue.shift();
  try {
    const serviceUrl = DOMManager.getServiceUrl();
    const targetLangs = DOMManager.getTargetLanguages();
    if (targetLangs.length === 0) {
      Logger.debug('無目標語言，跳過翻譯');
      return;
    }
    const minDisplayTime = serviceUrl.startsWith('GAS://')
      ? 0
      : (CONFIG.DISPLAY_TIME_RULES[sourceLang] || CONFIG.DISPLAY_TIME_RULES.default)
          .find(rule => text.length <= rule.maxLength).time;
    Logger.debug('計算顯示時間:', { sourceLang, textLength: text.length, minDisplayTime });
    const data = await processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, '');
    if (data) {
      DisplayManager.addToBuffer(data, targetLangs, minDisplayTime);
    }
  } catch (error) {
    Logger.error('翻譯失敗:', { message: error.message, code: error.code, details: error.details });
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, sourceLang, browser) {
  translationQueue.push({ text, sourceLang, browser });
  Logger.debug('加入佇列:', { text, sourceLang, browser });
  await processQueue();
}

// 啟動與停止顯示緩衝區
function startDisplayBuffers() {
  DOMManager.cacheElements();
  animationFrameId = requestAnimationFrame(() => DisplayManager.processBuffers());
}

function stopDisplayBuffers() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  DisplayManager.displayBuffers.target1 = [];
  DisplayManager.displayBuffers.target2 = [];
  DisplayManager.displayBuffers.target3 = [];
  DisplayManager.currentDisplays.target1 = null;
  DisplayManager.currentDisplays.target2 = null;
  DisplayManager.currentDisplays.target3 = null;
  Logger.debug('顯示緩衝區已停止並清理');
}

// 初始化
document.addEventListener('DOMContentLoaded', startDisplayBuffers);

// 匯出公開 API
export { sendTranslationRequest, processTranslationUrl, stopDisplayBuffers };