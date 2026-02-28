/**
 * @file gtxTranslationService.js
 * @description Google Translate Extension (GTX) 翻譯模組。
 * 使用非官方的 Google Translate API 端點，支援自動重試與長句拼接。
 */

import { isDebugEnabled } from './logger.js';
import { getLang } from './config.js';

/**
 * 具備超時中斷與 429 重試機制的 fetch 封裝
 * @async
 * @param {string} url 
 * @param {Object} options 
 * @param {number} retries 
 * @param {number} delay 
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 10000);

  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timeoutId);

    if (response.status === 429 && retries > 0) {
      if (isDebugEnabled()) console.warn('[GTX] 偵測到 429 Too Many Requests，將在延遲後重試...', { retries, delay });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (retries > 0 && error.name !== 'AbortError') {
      if (isDebugEnabled()) console.warn('[GTX] 請求失敗，準備重試...', { error: error.message, retries });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Google Translate GTX 翻譯實作
 * @async
 * @param {string} text - 待翻譯文字
 * @param {Array<string>} targetLangs - 目標語言 ID 列表 (例如 ['zh-TW', 'en-US'])
 * @param {string} sourceLangId - 來源語言 ID (例如 'ja-JP')
 * @returns {Promise<Object|null>} 翻譯結果物件 { translations: [譯文1, 譯文2, ...] }
 */
export async function translateWithGTX(text, targetLangs, sourceLangId) {
  if (!text || text.trim() === '') return null;

  const results = await Promise.all(targetLangs.map(async (tlId) => {
    if (!tlId || tlId === 'none') return '';
    
    try {
      const sl = getGTXCode(sourceLangId) || 'auto';
      const tl = getGTXCode(tlId);
      
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.append('client', 'gtx');
      url.searchParams.append('dt', 't');
      url.searchParams.append('sl', sl);
      url.searchParams.append('tl', tl);
      url.searchParams.append('q', text);

      const data = await fetchWithRetry(url.toString(), { method: 'GET' });
      
      if (data && data[0]) {
        /* 解析回傳的嵌套陣列，遍歷 data[0] 並將所有 item[0] 片段拼接起來 */
        return data[0].map(item => item[0] || '').join('');
      }
      return '';
    } catch (error) {
      if (isDebugEnabled()) console.error('[GTX] 翻譯失敗:', { target: tlId, error: error.message });
      return '';
    }
  }));

  return { translations: results };
}

/**
 * 獲取適用於 Google Translate 的語言代碼
 * @param {string} langId 
 * @returns {string}
 */
function getGTXCode(langId) {
  const langObj = getLang(langId);
  if (!langObj) return langId;
  return langObj.languageModelApiCode || langId;
}
