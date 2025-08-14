import { keywordRules } from './speechCapture.js';
import { loadLanguageConfig, getChunkSize, getDisplayTimeRules, getTargetCodeById } from './config.js';

// 全局序列號計數器
let sequenceCounter = 0;
const maxConcurrent = 5; // 最大並發請求數
let activeRequests = 0; // 當前活動請求數

// 顯示緩衝區與當前顯示狀態
const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };

// 超時輔助函數
const timeout = (promise, time) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('請求超時')), time))
]);

// 在使用れいーモード的時候進行翻譯後的文字過濾
function filterTextWithKeywords(text, targetLang) {
  const rayModeButton = document.getElementById('raymode');
  const isRayModeActive = rayModeButton?.classList.contains('active') || false;
  if (!isRayModeActive) return text;

  let result = text;
  result = result.replace(/"/g, ''); // 過濾引號

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

// 發送翻譯請求的核心邏輯（POST 方式）
async function sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translation] 無效文字，跳過翻譯:', text);
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

  console.debug('[DEBUG] [Translation] 發送翻譯請求:', { text, targetLangs, sequenceId });

  const response = await timeout(fetch(serviceUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }), 10000); // 10 秒超時

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}

// 發送翻譯請求的 GET 方式
async function sendTranslationGet(text, targetLangs, sourceLang, serviceUrl, sequenceId) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translation] 無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl.match(/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/)) {
    console.error('[ERROR] [Translation] 無效的 Google Apps Script URL:', serviceUrl);
    throw new Error('無效的 Google Apps Script URL');
  }

  const queryParams = `text=${encodeURIComponent(text)}&targetLangs=${encodeURIComponent(JSON.stringify(targetLangs))}&sourceLang=${encodeURIComponent(sourceLang)}&sequenceId=${sequenceId}`;
  const url = `${serviceUrl}?${queryParams}`;

  if (url.length > 20000) {
    console.error('[ERROR] [Translation] URL 過長:', url.length);
    throw new Error('請求資料過長，請縮短文字內容');
  }

  // console.debug('[DEBUG] [Translation] 發送 GET 請求:', url);

  const response = await timeout(fetch(url, { method: 'GET', mode: 'cors' }), 10000); // 10 秒超時

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
  // console.debug('[DEBUG] [Translation] 接收 GET 回應:', data);
  return data;
}

// 處理 URL 並選擇 GET 或 POST 方式
async function processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, serviceKey, sequenceId) {
  if (!serviceUrl) {
    console.error('[ERROR] [Translation] URL 為空');
    throw new Error('請輸入有效的翻譯服務 URL');
  }

  if (serviceUrl.startsWith('GAS://')) {
    const scriptId = serviceUrl.replace('GAS://', '');
    if (!scriptId.match(/^[a-zA-Z0-9_-]+$/)) {
      console.error('[ERROR] [Translation] 無效的 Google Apps Script ID:', scriptId);
      throw new Error('Google Apps Script ID 只能包含字母、數字和連字符');
    }
    const gasUrl = `https://script.google.com/macros/s/${scriptId}/exec`;
    return await sendTranslationGet(text, targetLangs, sourceLang, gasUrl, sequenceId);
  } else {
    return await sendTranslation(text, targetLangs, serviceUrl, serviceKey, sequenceId);
  }
}

// 更新 UI 的邏輯
async function updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId) {
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };
  const isRayModeActive = document.getElementById('raymode')?.classList.contains('active') || false;

  targetLangs.forEach((lang, index) => {
    const span = spans[`target${index + 1}`];
    const langSelect = document.getElementById(`target${index + 1}-language`)?.value;
    if (span && data.translations && data.translations[index]) {
      const filteredText = isRayModeActive ? filterTextWithKeywords(data.translations[index], lang) : data.translations[index];
      
      displayBuffers[`target${index + 1}`].push({
        text: filteredText,
        minDisplayTime,
        sequenceId: data.sequenceId ?? sequenceId, // 使用後端返回的 sequenceId，若無則使用前端的
        timestamp: Date.now()
      });
      // console.debug('[DEBUG] [Translation] 緩衝區新增:', { lang, text: filteredText, minDisplayTime, sequenceId });
    }
  });
}

// 處理顯示緩衝區
function processDisplayBuffers() {
  const now = Date.now();
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };

  ['target1', 'target2', 'target3'].forEach(key => {
    const span = spans[key];
    if (!span || displayBuffers[key].length === 0) return;

    // 按 sequenceId 排序，若無 sequenceId 則按 timestamp
    displayBuffers[key].sort((a, b) => {
      if (a.sequenceId === undefined || b.sequenceId === undefined) {
        return a.timestamp - b.timestamp;
      }
      return a.sequenceId - b.sequenceId;
    });

    // 清理過舊的項目（超過 10 秒）
    displayBuffers[key] = displayBuffers[key].filter(item => now - item.timestamp < 10000);
    if (displayBuffers[key].length > 10) {
      displayBuffers[key] = displayBuffers[key].slice(-10);
      // console.debug('[DEBUG] [Translation] 緩衝區溢出，丟棄早期結果:', { key });
    }

    if (currentDisplays[key] && now - currentDisplays[key].startTime < currentDisplays[key].minDisplayTime * 1000) {
      return; // 未達 minDisplayTime
    }

    // 獲取最後顯示的 sequenceId，初始為 -1
    const lastSequenceId = currentDisplays[key]?.sequenceId ?? -1;

    // 查找 sequenceId > lastSequenceId 的最小項目
    const nextIndex = displayBuffers[key].findIndex(item => item.sequenceId > lastSequenceId);
    if (nextIndex !== -1) {
      const next = displayBuffers[key].splice(nextIndex, 1)[0]; // 取出匹配項目
      currentDisplays[key] = {
        text: next.text,
        startTime: now,
        minDisplayTime: next.minDisplayTime,
        sequenceId: next.sequenceId
      };
      span.textContent = next.text;
      span.dataset.stroke = next.text;
      span.style.display = 'inline-block';
      span.offsetHeight;
      span.style.display = '';
      const langSelect = document.getElementById(`${key}-language`)?.value;
      const chunkSize = getChunkSize(langSelect) || 40;
      if (next.text.length > chunkSize) {
        span.classList.add('multi-line');
        // console.debug('[DEBUG] [Translation] 應用縮小字體:', { lang: langSelect, length: next.text.length, chunkSize });
      } else {
        span.classList.remove('multi-line');
        // console.debug('[DEBUG] [Translation] 移除縮小字體:', { lang: langSelect, length: next.text.length, chunkSize });
      }
      console.info('[INFO] [Translation] 更新翻譯文字:', { lang: langSelect, text: next.text, sequenceId: next.sequenceId });
    }
  });
  requestAnimationFrame(processDisplayBuffers);
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, sourceLang, browser) {
  if (activeRequests >= maxConcurrent) {
    // console.debug('[DEBUG] [Translation] 達到並發上限，延遲重試');
    setTimeout(() => sendTranslationRequest(text, sourceLang, browser), 100);
    return;
  }

  activeRequests++;
  const sequenceId = sequenceCounter++;
  // console.debug('[DEBUG] [Translation] 發送請求:', { text, sourceLang, browser, sequenceId });

  try {
    const serviceUrl = document.getElementById('translation-link').value;
    const targetLangs = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none').map(lang => getTargetCodeById(lang));

    if (targetLangs.length === 0) {
      // console.debug('[DEBUG] [Translation] 無目標語言，跳過翻譯');
      return;
    }

    const rules = getDisplayTimeRules(sourceLang) || getDisplayTimeRules('default');
    const minDisplayTime = serviceUrl.startsWith('GAS://') 
      ? 0 
      : rules.find(rule => text.length <= rule.maxLength).time;

    // console.debug('[DEBUG] [Translation] 計算顯示時間:', { sourceLang, textLength: text.length, minDisplayTime });

    const data = await processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, '', sequenceId);
    if (data) {
      await updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId);
    }
  } catch (error) {
    console.error('[ERROR] [Translation] 翻譯失敗:', { sequenceId, error: error.message });
  } finally {
    activeRequests--;
  }
}

// 啟動顯示緩衝區處理並定期重置 sequenceCounter
document.addEventListener('DOMContentLoaded', async () => {
  await loadLanguageConfig();
  requestAnimationFrame(processDisplayBuffers);
  setInterval(() => {
    sequenceCounter = 0;
    // 重置 currentDisplays 的 sequenceId
    currentDisplays.target1 = null;
    currentDisplays.target2 = null;
    currentDisplays.target3 = null;
    // console.debug('[DEBUG] [Translation] 重置 sequenceCounter 和 currentDisplays');
  }, 3600000); // 1 小時
});

export { sendTranslationRequest, processTranslationUrl };