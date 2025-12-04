import { browserInfo, keywordRules } from './speechCapture.js';
import { getChunkSize, getDisplayTimeRules, getTargetCodeById, isRayModeActive, isPromptApiActive, isTranslationApiActive } from './config.js';
import { sendLocalTranslation } from './translatorApiService.js';
import { sendPromptTranslation } from './promptTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';

// Chrome Translator API用參數
const translatorCache = new Map();

// 全局序列號計數器
let sequenceCounter = 0;
let bufferCheckInterval = null; // 用於追蹤 setInterval
let lastLogTime = 0;
const LOG_THROTTLE_MS = 1000; // 日誌節流，每 1000ms 記錄一次

// 顯示緩衝區與當前顯示狀態
const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };

// 併發控制佇列
const queue = [];
let inFlight = 0;
const MAX = 5; // 最大並發請求數

// 佇列管理函數：將任務加入佇列
function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

// 佇列管理函數：處理佇列中的任務
async function pump() {
  if (inFlight >= MAX) return;
  const next = queue.shift();
  if (!next) return;

  inFlight++;
  try {
    //console.debug('[DEBUG] [Translation] 執行佇列任務:', { inFlight, queueLength: queue.length });
    next.resolve(await next.task());
  } catch (e) {
    console.error('[ERROR] [Translation] 佇列任務失敗:', { error: e.message });
    next.reject(e);
  } finally {
    inFlight--;
    console.debug('[DEBUG] [Translation] 任務完成，繼續處理佇列:', { inFlight, queueLength: queue.length });
    pump();
  }
}

// 在使用れいーモード的時候進行翻譯後的文字過濾
function filterTextWithKeywords(text, targetLang) {
  if (!isRayModeActive()) return text;

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
  
  if (details) {
    const detailStrings = Object.entries(details)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    displayText = `${text} ${detailStrings}`;
  }

  if (statusDisplay && statusDisplay.textContent !== displayText) {
    statusDisplay.textContent = displayText;
    statusDisplay.dataset.stroke = displayText;
  }
}

// 更新 UI 的邏輯
async function updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId) {
  const stopbutton = document.getElementById('stop-recording');
  if (stopbutton.disabled) {
    console.debug('[DEBUG] [Translation] 停止按鈕啟用，跳過更新 UI');
    return;
  }

  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };

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
      const filteredText = isRayModeActive() ? filterTextWithKeywords(data.translations[index], lang) : data.translations[index];
      
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

  processDisplayBuffers();
  if (!bufferCheckInterval) {
    bufferCheckInterval = setInterval(processDisplayBuffers, 500);
    //console.debug('[DEBUG] [Translation] 啟動緩衝區監控，間隔 500ms');
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
      //console.debug('[DEBUG] [Translation] processDisplayBuffers 無數據');
      lastLogTime = now;
    }
    if (bufferCheckInterval) {
      clearInterval(bufferCheckInterval);
      bufferCheckInterval = null;
      //console.debug('[DEBUG] [Translation] 停止緩衝區監控，無數據');
    }
    return;
  }

  ['target1', 'target2', 'target3'].forEach(key => {
    const span = spans[key];
    if (!span || displayBuffers[key].length === 0) {
      if (now - lastLogTime >= LOG_THROTTLE_MS) {
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
        // 移除舊動畫並觸發新動畫
        span.getAnimations?.().forEach(a => a.cancel());
        span.classList.remove('flash');
        requestAnimationFrame(() => {
          span.classList.add('flash');
          //console.debug('[DEBUG] [Translation] 更新 target-text:', { target: key, text: next.text, sequenceId: next.sequenceId });
        });
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
          //console.debug('[DEBUG] [Translation] 無新結果可顯示:', { key, lastSequenceId });
          lastLogTime = now;
        }
      }
    } catch (error) {
      console.error('[ERROR] [Translation] processDisplayBuffers 錯誤:', { key, error: error.message });
    }
  });
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, sourceLang) {
  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

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

      const isLocalPromptApiActive = isPromptApiActive() || false;
      const isLocalTranslationActive = isTranslationApiActive() || false;

      // 翻譯後緩衝時間規則
      const rules = getDisplayTimeRules(sourceLang) || getDisplayTimeRules('default');
      const minDisplayTime = serviceUrl.startsWith('GAS://') || isLocalTranslationActive || isLocalPromptApiActive
        ? 0
        : rules.find(rule => text.length <= rule.maxLength).time;

      //console.debug('[DEBUG] [Translation] 計算顯示時間:', { sourceLang, textLength: text.length, minDisplayTime });

      let data;
      
      // 根據選擇的翻譯服務進行翻譯
      // 順序為 Prompt API > 本地翻譯 > 遠端翻譯
      if (isLocalPromptApiActive && 'LanguageModel' in self) {
        console.debug('[DEBUG] [Translation] 執行 Prompt API 翻譯:', { sequenceId });
        try {
          console.info(sourceLang, targetLangs);
          data = await sendPromptTranslation(text, targetLangs, sourceLang);
          //console.debug('[DEBUG] [Translation] Prompt API 移除回調確認:', { sequenceId });
        } catch (error) {
          console.error('[ERROR] [Translation] Prompt API 翻譯失敗:', { sequenceId, error: error.message });
          updateStatusDisplay('翻訳エラー:', { sequenceId, error: error.message });
          setTimeout(() => updateStatusDisplay(''), 5000);
          throw error;
        }
      } else if (isLocalTranslationActive && browserInfo.supportsTranslatorAPI) {
        console.debug('[DEBUG] [Translation] 執行本地翻譯:', { sequenceId });
        data = await sendLocalTranslation(text, targetLangs, sourceLang); // 移除回調函數
      } else {
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
      throw error;
    }
  });
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
  // 清理佇列
  queue.forEach(task => task.reject(new Error('頁面即將關閉，任務被取消')));
  queue.length = 0;
  console.debug('[DEBUG] [Translation] 清理佇列');
});

export { sendTranslationRequest, sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI };