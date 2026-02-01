/**
 * @file config.js
 * @description 語系管理中心。採用 Map 儲存池模式，將分散的 JSON 配置物件化。
 */

import { Logger } from './logger.js';

// #region [狀態變數]
/** @type {Map<string, Object>} 語系物件儲存池 (Key 統一為語言 ID) */
const _languages = new Map();

let _config = null;
let _isRayModeActive   = false;
let _isForceSingleLine = false;
let _isDeepgramActive  = false;

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
      promptApiCode: item.promptApiCode || item.id,
      languageModelApiCode: item.languageModelApiCode || json.targetCodeMap[item.id] || item.id,
      deepgramCode: json.targetCodeMap[item.id] || item.id,
      chunkSize: item.chunkSize || json.defaults?.chunkSize || 40,
      displayTimeRules: item.displayTimeRules || json.defaults?.displayTimeRules || []
    };

    _languages.set(item.id, langObj);
  });

  Logger.debug(`[DEBUG] [config] 初始化完成，共 ${_languages.size} 個語系物件`);
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
export function isRayModeActive() { return _isRayModeActive; }
export function setRayModeStatus(status) { _isRayModeActive = !!status; }

export function isForceSingleLine() { return _isForceSingleLine; }
export function setForceSingleLineStatus(status) { _isForceSingleLine = !!status; }

export function isDeepgramActive() { return _isDeepgramActive; }
export function setDeepgramStatus(status) { _isDeepgramActive = String(status) === 'true'; }

export function getAlignment() { return _currentAlignment; }
export function setAlignment(align) { _currentAlignment = align; }

export async function getSourceLanguage() {
  return document.getElementById('source-language')?.value || null;
}
// #endregion