// translationController.js
import { keywordRules } from './speechCapture.js';
import { loadLanguageConfig, getChunkSize, getDisplayTimeRules, getTargetCodeById, getTargetCodeForTranslator } from './config.js';
import { sendLocalTranslation } from './translatorApiService.js'

// Chrome Translator API用參數
const translatorCache = new Map();

// 全局序列號計數器
let sequenceCounter = 0;
const maxConcurrent = 5; // 最大並發請求數
let activeRequests = 0; // 當前活動請求數
let bufferCheckInterval = null; // 用於追蹤 setInterval
let lastLogTime = 0;
const LOG_THROTTLE_MS = 1000; // 日誌節流，每 1000ms 記錄一次

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

// 更新status-panel的訊息用
function updateStatusDisplay(text, details = null) {
  const statusDisplay = document.getElementById('status-display');
  let displayText = text;
  
  // 如果有 details 物件，格式化為字串
  if (details) {
    const detailStrings = Object.entries(details)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    displayText = `${text} ${detailStrings}`;
  }

  if (statusDisplay && statusDisplay.textContent !== displayText) {
    requestAnimationFrame(() => {
      statusDisplay.textContent = displayText;
      statusDisplay.dataset.stroke = displayText;
      statusDisplay.style.display = 'inline-block';
      statusDisplay.offsetHeight;
      statusDisplay.style.display = '';
    });
  }
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

  const response = await timeout(fetch(url, { method: 'GET', mode: 'cors' }), 10000); // 10 秒超時

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
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

  console.debug('[DEBUG] [Translation] updateTranslationUI 開始:', { 
    data: data, 
    targetLangs: targetLangs, 
    sequenceId: sequenceId, 
    translations: data?.translations 
  });

  targetLangs.forEach((lang, index) => {
    const span = spans[`target${index + 1}`];
    const langSelect = document.getElementById(`target${index + 1}-language`)?.value;
    if (span && data?.translations && data.translations[index]) {
      const filteredText = isRayModeActive ? filterTextWithKeywords(data.translations[index], lang) : data.translations[index];
      
      displayBuffers[`target${index + 1}`].push({
        text: filteredText,
        minDisplayTime,
        sequenceId: data.sequenceId ?? sequenceId,
        timestamp: Date.now()
      });
      console.debug('[DEBUG] [Translation] 推入 displayBuffers:', { 
        target: `target${index + 1}`, 
        text: filteredText, 
        sequenceId: data.sequenceId ?? sequenceId 
      });
    } else {
      console.warn('[WARN] [Translation] 無法推入 displayBuffers:', { 
        spanExists: !!span, 
        translationExists: !!data?.translations?.[index], 
        index, 
        data: data 
      });
    }
  });

  // 立即檢查緩衝區並啟動定時器
  processDisplayBuffers();
  if (!bufferCheckInterval) {
    bufferCheckInterval = setInterval(processDisplayBuffers, 500);
    console.debug('[DEBUG] [Translation] 啟動緩衝區監控，間隔 500ms');
  }
}

// 處理顯示緩衝區
function processDisplayBuffers() {
  const now = Date.now();
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };

  const hasData = ['target1', 'target2', 'target3'].some(key => displayBuffers[key].length > 0);
  if (!hasData) {
    if (now - lastLogTime >= LOG_THROTTLE_MS) {
      console.debug('[DEBUG] [Translation] processDisplayBuffers 無數據');
      lastLogTime = now;
    }
    if (bufferCheckInterval) {
      clearInterval(bufferCheckInterval);
      bufferCheckInterval = null;
      console.debug('[DEBUG] [Translation] 停止緩衝區監控，無數據');
    }
    return;
  }

  if (now - lastLogTime >= LOG_THROTTLE_MS) {
    console.debug('[DEBUG] [Translation] processDisplayBuffers 執行:', { 
      buffers: Object.keys(displayBuffers).map(key => ({ key, length: displayBuffers[key].length })) 
    });
    lastLogTime = now;
  }

  ['target1', 'target2', 'target3'].forEach(key => {
    const span = spans[key];
    if (!span || displayBuffers[key].length === 0) {
      if (now - lastLogTime >= LOG_THROTTLE_MS) {
        console.debug('[DEBUG] [Translation] 跳過處理:', { 
          key, 
          spanExists: !!span, 
          bufferLength: displayBuffers[key].length 
        });
        lastLogTime = now;
      }
      return;
    }

    try {
      displayBuffers[key].sort((a, b) => {
        if (a.sequenceId === undefined || b.sequenceId === undefined) {
          return a.timestamp - b.timestamp;
        }
        return a.sequenceId - b.sequenceId;
      });

      displayBuffers[key] = displayBuffers[key].filter(item => now - item.timestamp < 10000);
      if (displayBuffers[key].length > 10) {
        displayBuffers[key] = displayBuffers[key].slice(-10);
      }

      if (currentDisplays[key] && now - currentDisplays[key].startTime < currentDisplays[key].minDisplayTime * 1000) {
        if (now - lastLogTime >= LOG_THROTTLE_MS) {
          console.debug('[DEBUG] [Translation] 未達 minDisplayTime，跳過:', { 
            key, 
            currentDisplay: currentDisplays[key] 
          });
          lastLogTime = now;
        }
        return;
      }

      const lastSequenceId = currentDisplays[key]?.sequenceId ?? -1;
      const nextIndex = displayBuffers[key].findIndex(item => item.sequenceId > lastSequenceId);
      if (nextIndex !== -1) {
        const next = displayBuffers[key].splice(nextIndex, 1)[0];
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
        } else {
          span.classList.remove('multi-line');
        }
        console.info('[INFO] [Translation] 更新翻譯文字:', { 
          lang: langSelect, 
          text: next.text, 
          sequenceId: next.sequenceId 
        });
      } else {
        if (now - lastLogTime >= LOG_THROTTLE_MS) {
          console.debug('[DEBUG] [Translation] 無新結果可顯示:', { key, lastSequenceId });
          lastLogTime = now;
        }
      }
    } catch (error) {
      console.error('[ERROR] [Translation] processDisplayBuffers 錯誤:', { key, error: error.message });
    }
  });
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, sourceLang, browserInfo, isLocalTranslationActive) {
  if (activeRequests >= maxConcurrent) {
    console.debug('[DEBUG] [Translation] 達到並發上限，延遲重試');
    setTimeout(() => sendTranslationRequest(text, sourceLang, browserInfo, isLocalTranslationActive), 100);
    return;
  }

  activeRequests++;
  const sequenceId = sequenceCounter++;
  console.debug('[DEBUG] [Translation] 發送請求:', { text, sourceLang, browser: browserInfo.browser, sequenceId });

  try {
    const serviceUrl = document.getElementById('translation-link').value;
    const targetLangs = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none').map(lang => getTargetCodeById(lang));

    if (targetLangs.length === 0) {
      console.debug('[DEBUG] [Translation] 無目標語言，跳過翻譯');
      return;
    }

    const rules = getDisplayTimeRules(sourceLang) || getDisplayTimeRules('default');
    const minDisplayTime = serviceUrl.startsWith('GAS://') 
      ? 0 
      : rules.find(rule => text.length <= rule.maxLength).time;

    console.debug('[DEBUG] [Translation] 計算顯示時間:', { sourceLang, textLength: text.length, minDisplayTime });

    let data;
    if (isLocalTranslationActive && browserInfo.supportsTranslatorAPI) {
      data = await sendLocalTranslation(text, targetLangs, sourceLang, (text) => {
        const sourceText = document.getElementById('source-text');
        if (sourceText && text.trim().length !== 0 && sourceText.textContent !== text) {
          requestAnimationFrame(() => {
            sourceText.textContent = text;
            sourceText.dataset.stroke = text;
            sourceText.style.display = 'inline-block';
            sourceText.offsetHeight;
            sourceText.style.display = '';
          });
        }
      });
    }

    if (!data) {
      data = await processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, '', sequenceId);
    }

    console.debug('[DEBUG] [Translation] 翻譯結果數據:', { data, sequenceId });

    if (data) {
      await updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId);
    } else {
      console.warn('[WARN] [Translation] 無有效翻譯結果:', { text, sequenceId });
    }
  } catch (error) {
    console.error('[ERROR] [Translation] 翻譯失敗:', { sequenceId, error: error.message });
    updateStatusDisplay('翻訳エラー:', { sequenceId, error: error.message });
    setTimeout(() => updateStatusDisplay(''), 5000);
  } finally {
    activeRequests--;
  }
}

// 啟動顯示緩衝區處理並定期重置 sequenceCounter
window.addEventListener('beforeunload', () => {
  translatorCache.forEach((translator, cacheKey) => {
    translator.destroy();
    console.debug('[DEBUG] [Translation] 清理 Translator 物件:', { cacheKey });
  });
  translatorCache.clear();
  console.debug('[DEBUG] [Translation] 清理 translatorCache');
  if (bufferCheckInterval) {
    clearInterval(bufferCheckInterval);
    bufferCheckInterval = null;
    console.debug('[DEBUG] [Translation] 清理 bufferCheckInterval');
  }
});

export { sendTranslationRequest, sequenceCounter, translatorCache, processTranslationUrl, updateStatusDisplay, updateTranslationUI };