import { Logger } from './logger.js';

// 遠端翻譯服務模組，處理所有遠端請求邏輯

// 遠端請求超時輔助函式
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

// 發送翻譯請求的核心邏輯（POST 方式）
async function sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId, previousText = null) {
  // 1. 基礎參數檢核
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    Logger.debug('[DEBUG]', '[remoteTranslationService.js]', '無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl) throw new Error('Service URL is empty.');

  let finalUrl = serviceUrl.trim();

  // 2. 解析特殊協議格式 (例如: my-secret-key://my-server.com)
  const protocolMatch = finalUrl.match(/^([a-zA-Z0-9-]+):\/\/(.+)$/);

  if (protocolMatch) {
    const scheme = protocolMatch[1].toLowerCase();
    // 如果開頭不是 http 也不是 https，我們就假設它是 API Key (維持既有邏輯)
    if (scheme !== 'http' && scheme !== 'https') {
      serviceKey = protocolMatch[1]; // 提取 Key
      finalUrl = protocolMatch[2];   // 提取剩下的網址部分 (去除 key://)

      localStorage.setItem('api-key-value', serviceKey);
    }
  }

  // 3. 智慧協定補全 (Protocol Auto-fill)
  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    const isLocal = finalUrl.includes('localhost') || finalUrl.includes('127.0.0.1');
    const protocol = isLocal ? 'http' : 'https';
    finalUrl = `${protocol}://${finalUrl}`;
  }

  // 4. 路徑補全
  // 確保網址結尾是 /translate，避免重複疊加
  if (!finalUrl.endsWith('/translate')) {
    // 移除尾部可能多餘的斜線，再接上路徑
    finalUrl = finalUrl.replace(/\/+$/, '') + '/translate';
  }

  // 5. 最終格式檢查 (原本的檢查邏輯保留，確保安全性)
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?\/translate$/.test(finalUrl)) {
    throw new Error(`Invalid URL format: ${finalUrl}`);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (serviceKey) headers['X-API-Key'] = serviceKey;

  // [新增] 將 previousText 加入 payload
  const payload = { 
    text, 
    targetLangs, 
    sequenceId, 
    previousText: previousText || null // 若未提供則為 null
  };

  //Logger.debug('[DEBUG]', '[remoteTranslationService.js]', '發送翻譯請求 (含 Context):', { url: finalUrl, sequenceId, hasContext: !!previousText });

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

// 發送翻譯請求的 GET 方式（適用於 Google Apps Script）
async function sendTranslationGet(text, targetLangs, sourceLang, serviceUrl, sequenceId) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    Logger.debug('[DEBUG] [remoteTranslationService] 無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/)) {
    Logger.error('[ERROR] [remoteTranslationService] 無效的 Google Apps Script URL:', serviceUrl);
    throw new Error('無效的 Google Apps Script URL');
  }

  const queryParams = `text=${encodeURIComponent(text)}&targetLangs=${encodeURIComponent(JSON.stringify(targetLangs))}&sourceLang=${encodeURIComponent(sourceLang)}&sequenceId=${sequenceId}`;
  const url = `${serviceUrl}?${queryParams}`;

  if (url.length > 20000) {
    Logger.error('[ERROR] [remoteTranslationService] URL 過長:', url.length);
    throw new Error('請求資料過長，請縮短文字內容');
  }

  const response = await fetchWithTimeout(url, { method: 'GET', mode: 'cors' }, 10000);

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
  return data;
}

// 處理 URL 並選擇 GET 或 POST 方式
async function processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, serviceKey, sequenceId, previousText = null) {
  if (!serviceUrl) {
    Logger.error('[ERROR]', '[remoteTranslationService.js]', 'URL 為空');
    throw new Error('有効な翻訳サービスの URL を入力してください。');
  }

  if (serviceUrl.startsWith('GAS://')) {
    const scriptId = serviceUrl.replace('GAS://', '');
    if (!scriptId.match(/^[a-zA-Z0-9_-]+$/)) {
      Logger.error('[ERROR]', '[remoteTranslationService.js]', '無效的 Google Apps Script ID:', scriptId);
      throw new Error('Google Apps Script ID 只能包含字母、數字和連字符');
    }
    const gasUrl = `https://script.google.com/macros/s/${scriptId}/exec`;
    return await sendTranslationGet(text, targetLangs, sourceLang, gasUrl, sequenceId);
  } else {
    // 自架後端路徑：傳遞 previousText
    return await sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId, previousText);
  }
}

export { sendTranslation, processTranslationUrl };