/**
 * @file remoteTranslationService.js
 * @description 遠端翻譯通訊模組。支援 POST (自訂伺服器) 與 GET (Google Apps Script) 雙通訊模式。
 * 此檔用途為發送雲端請求，需搭配後端程式碼使用。
 */

import { isDebugEnabled } from './logger.js';

// #region [工具函式]

/**
 * 具備超時中斷功能的 fetch 封裝
 * @async
 * @param {string|URL} input - 請求目標
 * @param {RequestInit} init - 請求設定
 * @param {number} ms - 超時毫秒數 (預設 10000ms)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(input, init = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}
// #endregion

// #region [POST 請求核心邏輯]

/**
 * 發送標準 POST 翻譯請求 (適用於自架後端或 API 轉接層)
 * @async
 * @param {string} text - 待翻譯文字
 * @param {Array<string>} targetLangs - 目標語言代碼陣列
 * @param {string} serviceUrl - 服務網址
 * @param {string|null} serviceKey - API Key
 * @param {number} sequenceId - 請求序號
 * @param {string|null} previousText - 上文脈絡 (Context)
 * @returns {Promise<Object|null>} 翻譯結果物件
 */
async function sendTranslation(text, targetLangs, sourceLang, serviceUrl, sequenceId, previousText = null) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    if (isDebugEnabled()) console.debug('[DEBUG]', '[remoteTranslationService.js]', '無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl) throw new Error('Service URL is empty.');

  let finalUrl = serviceUrl.trim();
  let serviceKey = '';

  /* 技術備註：解析自訂協議格式 (如 key://url)，自動提取 API Key 並存入 localStorage */
  const protocolMatch = finalUrl.match(/^([a-zA-Z0-9-]+):\/\/(.+)$/);
  if (protocolMatch) {
    const scheme = protocolMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      serviceKey = protocolMatch[1];
      finalUrl = protocolMatch[2];
      localStorage.setItem('api-key-value', serviceKey);
    }
  }

  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    const isLocal = finalUrl.includes('localhost') || finalUrl.includes('127.0.0.1');
    finalUrl = `${isLocal ? 'http' : 'https'}://${finalUrl}`;
  }

  if (!finalUrl.endsWith('/translate')) {
    finalUrl = finalUrl.replace(/\/+$/, '') + '/translate';
  }

  /* 安全性檢查：確保符合標準 URL 格式 */
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?\/translate$/.test(finalUrl)) {
    throw new Error(`Invalid URL format: ${finalUrl}`);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (serviceKey) headers['X-API-Key'] = serviceKey;

  const payload = { 
    text, 
    targetLangs,
    sourceLang,
    sequenceId, 
    previousText: previousText || null 
  };

  const response = await fetchWithTimeout(finalUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, 10000);

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}
// #endregion

// #region [GAS (GET) 請求核心邏輯]

/**
 * 發送 GET 請求至 Google Apps Script 
 * @async
 * @param {string} text 
 * @param {Array<string>} targetLangs 
 * @param {string} sourceLang 
 * @param {string} serviceUrl 
 * @param {number} sequenceId 
 * @returns {Promise<Object|null>}
 */
async function sendTranslationToGas(text, targetLangs, sourceLang, serviceUrl, sequenceId) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    if (isDebugEnabled()) console.debug('[DEBUG] [remoteTranslationService] 無效文字，跳過翻譯:', text);
    return null;
  }

  /* 嚴格檢查是否為有效的 Google Script 佈署網址 */
  if (!serviceUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/)) {
    if (isDebugEnabled()) console.error('[ERROR] [remoteTranslationService] 無效的 GAS URL:', serviceUrl);
    throw new Error('無效的 Google Apps Script URL');
  }

  const queryParams = `text=${encodeURIComponent(text)}&targetLangs=${encodeURIComponent(JSON.stringify(targetLangs))}&sourceLang=${encodeURIComponent(sourceLang)}&sequenceId=${sequenceId}`;
  const url = `${serviceUrl}?${queryParams}`;

  /* GAS GET 請求限制：URL 總長度不得超過 20,000 字元 */
  if (url.length > 20000) {
    if (isDebugEnabled()) console.error('[ERROR] [remoteTranslationService] URL 過長:', url.length);
    throw new Error('請求資料過長，請縮短文字內容');
  }

  const response = await fetchWithTimeout(url, { method: 'GET', mode: 'cors' }, 10000);

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}
// #endregion

// #region [路由與分流入口]

/**
 * 根據 URL 格式自動分配請求至 GAS 或自訂伺服器處理器
 * @async
 * @param {string} text - 待翻譯文字
 * @param {Array<string>} targetLangs - 目標語言
 * @param {string} sourceLang  - 來源語言
 * @param {string} serviceUrl  - 原始網址或 GAS ID
 * @param {string} serviceType - 翻譯服務類型
 * @param {number} sequenceId  - 序號
 * @param {string|null} previousText - 上文
 * @returns {Promise<Object>}
 */
async function processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, serviceType, sequenceId, previousText = null) {
  if (!serviceUrl) {
    if (isDebugEnabled()) console.error('[ERROR]', '[remoteTranslationService.js]', 'URL 為空');
    throw new Error('有効な翻訳サービスの URL を入力してください。');
  }

  if (serviceType === 'gas') {
    return await sendTranslationToGas(text, targetLangs, sourceLang, serviceUrl, sequenceId);
  } else if (serviceType === 'link') {
    return await sendTranslation(text, targetLangs, sourceLang, serviceUrl, sequenceId, previousText);
  } else {
    if (isDebugEnabled()) console.error('[ERROR]', '[remoteTranslationService.js]', '無效的服務類型:', serviceType);
    throw new Error('無效的服務類型');
  }
}
// #endregion

export { sendTranslation, processTranslationUrl };