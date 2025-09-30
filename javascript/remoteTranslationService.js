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
async function sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。' ) {
    console.debug('[DEBUG] [remoteTranslationService] 無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl) throw new Error('Service URL is empty.');

  const urlPattern = /^\s*(\w+):\/\/(.+)$/;
  const match = serviceUrl.match(urlPattern);
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

  serviceUrl = `https://${serviceUrl}/translate`;

  if (!/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?\/translate$/.test(serviceUrl)) {
    throw new Error('Invalid URL format.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (serviceKey) headers['X-API-Key'] = serviceKey;

  const payload = { text, targetLangs, sequenceId };

  console.debug('[DEBUG] [remoteTranslationService] 發送翻譯請求:', { text, targetLangs, sequenceId });

  const response = await fetchWithTimeout(serviceUrl, {
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
    console.debug('[DEBUG] [remoteTranslationService] 無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/)) {
    console.error('[ERROR] [remoteTranslationService] 無效的 Google Apps Script URL:', serviceUrl);
    throw new Error('無效的 Google Apps Script URL');
  }

  const queryParams = `text=${encodeURIComponent(text)}&targetLangs=${encodeURIComponent(JSON.stringify(targetLangs))}&sourceLang=${encodeURIComponent(sourceLang)}&sequenceId=${sequenceId}`;
  const url = `${serviceUrl}?${queryParams}`;

  if (url.length > 20000) {
    console.error('[ERROR] [remoteTranslationService] URL 過長:', url.length);
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
async function processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, serviceKey, sequenceId) {
  if (!serviceUrl) {
    console.error('[ERROR] [remoteTranslationService] URL 為空');
    throw new Error('請輸入有效的翻譯服務 URL');
  }

  if (serviceUrl.startsWith('GAS://')) {
    const scriptId = serviceUrl.replace('GAS://', '');
    if (!scriptId.match(/^[a-zA-Z0-9_-]+$/)) {
      console.error('[ERROR] [remoteTranslationService] 無效的 Google Apps Script ID:', scriptId);
      throw new Error('Google Apps Script ID 只能包含字母、數字和連字符');
    }
    const gasUrl = `https://script.google.com/macros/s/${scriptId}/exec`;
    return await sendTranslationGet(text, targetLangs, sourceLang, gasUrl, sequenceId);
  } else {
    return await sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId);
  }
}

export { fetchWithTimeout, sendTranslation, sendTranslationGet, processTranslationUrl };