/**
 * @file config.js
 * @description 語系管理中心。採用 Map 儲存池模式，將分散的 JSON 配置物件化。
 */

import { createLogger } from './logger.js';

const log = createLogger('Config');

// #region [狀態變數]
/** @type {Map<string, Object>} 語系物件儲存池 (Key 統一為語言 ID) */
const _languages = new Map();

let _config = null;
let _isForceSingleLine = false;
let _currentSpeechEngine = 'soniox'; // 'webspeech' | 'soniox'

let _currentAlignment  = 'left';
// #endregion

// #region [環境偵測]
export const browserInfo = (() => {
  if (typeof navigator === 'undefined') return { browser: 'Unknown', isChrome: false, supportsTranslatorAPI: false };
  const userAgent = navigator.userAgent || '';
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) || [];
  const isEdge = brands.some(b => /Edge|Microsoft\s?Edge/i.test(b)) || /Edg\//.test(userAgent);
  const isChrome = !isEdge && (brands.some(b => /Google Chrome/i.test(b)) || /Chrome\//.test(userAgent));

  return { 
    browser: isEdge ? 'Edge' : isChrome ? 'Chrome' : 'Unknown', 
    isChrome, 
    /* Chrome & Edge(實驗通道版) Translator API 介面檢測 */
    supportsTranslatorAPI: 'Translator' in self
  };
})();
// #endregion

// #region [核心載入與物件化]

/**
 * 載入配置並建立統一語系實體
 * @async
 */
export async function loadLanguageConfig(url = './data/language_config.json') {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`[config] 載入失敗: ${res.status}`);

  const json = await res.json();
  _config = json;
  _languages.clear();

  json.languages.forEach(item => {
    /* 整合 JSON 原始內容與預設規則，產生標準化存取物件 */
    const langObj = {
      ...item,
      languageModelApiCode: item.languageModelApiCode || json.targetCodeMap[item.id] || item.id,
      deepgramCode: json.targetCodeMap[item.id] || item.id,
      chunkSize: item.chunkSize || json.defaults?.chunkSize || 40,
      displayTimeRules: item.displayTimeRules || json.defaults?.displayTimeRules || []
    };

    _languages.set(item.id, langObj);
  });

  log.debug(`初始化完成，共 ${_languages.size} 個語系物件`);
  return json;
}

/**
 * 取得語系物件 (全專案唯一存取點)
 * @param {string} id - 語言標識符 (如 'ja-JP')
 */
export function getLang(id) {
  if (!_config) throw new Error('[config] 尚未初始化');
  return _languages.get(id) || null;
}

/** 獲取完整清單供 UI 生成選單使用 */
export function getAllLanguages() {
  return Array.from(_languages.values());
}
// #endregion

// #region [狀態管理 API]
// 此為專用工具，因此 Ray Mode 永遠啟用（已移除切換按鈕）
export function isRayModeActive() { return true; }

export function isForceSingleLine() { return _isForceSingleLine; }
export function setForceSingleLineStatus(status) { _isForceSingleLine = !!status; }

export function getSpeechEngine() { return _currentSpeechEngine; }
export function setSpeechEngine(engine) {
  const valid = engine === 'soniox' || engine === 'webspeech';
  _currentSpeechEngine = valid ? engine : 'webspeech';
}

// Soniox 端點偵測的調整值。
// 設定僅在連線時（socket.onopen）傳送一次，因此變更會從下次「開始」起生效。
const SONIOX_ENDPOINT_DEFAULTS = {
  latencyLevel: 0,      // 0-3。數值越高越早確認，但辨識準確度會降低
  sensitivity: 0,       // -1.0~1.0。數值越負越不易斷句（使翻譯上下文維持較長）
  maxDelayMs: 1000      // 500-3000。語音結束後必須斷句的最長等待時間
};

let _sonioxEndpoint = { ...SONIOX_ENDPOINT_DEFAULTS };

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function getSonioxEndpointDefaults() { return { ...SONIOX_ENDPOINT_DEFAULTS }; }
export function getSonioxEndpointSettings() { return { ..._sonioxEndpoint }; }

export function setSonioxEndpointSetting(key, value) {
  if (!(key in SONIOX_ENDPOINT_DEFAULTS)) return;
  const fallback = SONIOX_ENDPOINT_DEFAULTS[key];
  if (key === 'latencyLevel') {
    _sonioxEndpoint.latencyLevel = Math.round(clampNumber(value, 0, 3, fallback));
  } else if (key === 'sensitivity') {
    _sonioxEndpoint.sensitivity = clampNumber(value, -1, 1, fallback);
  } else {
    _sonioxEndpoint.maxDelayMs = Math.round(clampNumber(value, 500, 3000, fallback));
  }
}

export function getAlignment() { return _currentAlignment; }
export function setAlignment(align) { _currentAlignment = align; }

export async function getSourceLanguage() {
  return document.getElementById('source-language')?.value || null;
}
// #endregion
