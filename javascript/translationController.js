import { keywordRules } from './speechCapture.js';
import { browserInfo, getChunkSize, getDisplayTimeRules, getTargetCodeById, isRayModeActive, isPromptApiActive, isTranslationApiActive } from './config.js';
import { sendLocalTranslation } from './translatorApiService.js';
import { sendPromptTranslation } from './promptTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { Logger } from './logger.js';

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

/**
 * 佇列管理核心 (Queue Pump)
 * 負責從 queue 中取出翻譯任務並執行，同時控制併發數 (MAX)。
 * @returns {Promise<void>}
 */
async function pump() {
  if (inFlight >= MAX) return;
  const next = queue.shift();
  if (!next) return;

  inFlight++;
  try {
    //Logger.debug('[DEBUG] [TranslationController] 執行佇列任務:', { inFlight, queueLength: queue.length });
    next.resolve(await next.task());
  } catch (e) {
    Logger.error('[ERROR] [TranslationController] 佇列任務失敗:', { error: e.message });
    next.reject(e);
  } finally {
    inFlight--;
    // Logger.debug('[DEBUG] [TranslationController] 任務完成，繼續處理佇列:', { inFlight, queueLength: queue.length });
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
    Logger.debug('[DEBUG] [TranslationController] 停止按鈕啟用，跳過更新 UI');
    return;
  }

  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };

  //Logger.debug('[DEBUG] [TranslationController] updateTranslationUI 開始:', { 
  //  data: data, 
  //  targetLangs: targetLangs, 
  //  sequenceId: sequenceId, 
  //  translations: data?.translations 
  //});

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
      //Logger.debug('[DEBUG] [TranslationController] 推入 displayBuffers:', { 
      //  target: `target${index + 1}`, 
      //  text: filteredText, 
      //  sequenceId: data.sequenceId ?? sequenceId 
      //});
    } else {
      Logger.warn('[WARN] [TranslationController] 無法推入 displayBuffers:', { 
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
    //Logger.debug('[DEBUG] [TranslationController] 啟動緩衝區監控，間隔 500ms');
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
      //Logger.debug('[DEBUG] [TranslationController] processDisplayBuffers 無數據');
      lastLogTime = now;
    }
    if (bufferCheckInterval) {
      clearInterval(bufferCheckInterval);
      bufferCheckInterval = null;
      //Logger.debug('[DEBUG] [TranslationController] 停止緩衝區監控，無數據');
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
          Logger.debug('[DEBUG] [TranslationController] 未達 minDisplayTime，跳過:', { 
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
          //Logger.debug('[DEBUG] [TranslationController] 更新 target-text:', { target: key, text: next.text, sequenceId: next.sequenceId });
        });
        const langSelect = document.getElementById(`${key}-language`)?.value;
        const chunkSize = getChunkSize(langSelect) || 40;
        if (next.text.length > chunkSize) {
          span.classList.add('multi-line');
        } else {
          span.classList.remove('multi-line');
        }
        Logger.info('[INFO] [TranslationController] 更新翻譯文字:', { 
          lang: langSelect, 
          text: next.text, 
          sequenceId: next.sequenceId 
        });
      } else {
        if (now - lastLogTime >= LOG_THROTTLE_MS) {
          //Logger.debug('[DEBUG] [TranslationController] 無新結果可顯示:', { key, lastSequenceId });
          lastLogTime = now;
        }
      }
    } catch (error) {
      Logger.error('[ERROR] [TranslationController] processDisplayBuffers 錯誤:', { key, error: error.message });
    }
  });
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, previousText = null, sourceLang) {
  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

    try {
      // 1. 取得 UI 元素與目前模式
      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'link';

      let serviceUrl = '';

      // 2. 根據模式，從不同的 Input 取得資料並格式化
      if (currentMode === 'gas') {
        // [新增] 模式：Google Apps Script
        // 從新的專用輸入框取值
        const gasInput = document.getElementById('gas-script-id');
        const rawId = gasInput ? gasInput.value.trim() : '';

        // 防呆處理：
        // 如果使用者習慣性貼上 "GAS://abc..."，我們將前綴移除，只留 ID
        // 然後統一組合成 "GAS://ID" 格式，讓 remoteTranslationService 識別
        const cleanId = rawId.replace(/^GAS:\/\//i, '');
        serviceUrl = cleanId ? `GAS://${cleanId}` : '';

      } else if (currentMode === 'link') {
        // [原有] 模式：自訂伺服器 (Custom Link)
        // 從舊的輸入框取值
        const linkInput = document.getElementById('translation-link');
        serviceUrl = linkInput ? linkInput.value.trim() : '';

      } else {
        // 其他模式 (fast, ai) 不需要 URL
        serviceUrl = '';
      }

      // 3. 取得並過濾目標語言
      const targetLangs = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ].filter(lang => lang && lang !== 'none').map(lang => getTargetCodeById(lang));

      if (targetLangs.length === 0) {
        Logger.debug('[DEBUG] [translationController.js] 無目標語言，跳過翻譯');
        return;
      }

      // 4. 判斷環境變數與顯示規則
      const isLocalPromptApiActive = isPromptApiActive() || false;
      const isLocalTranslationActive = isTranslationApiActive() || false;
      // 判斷是否為 GAS 模式 (根據上一步組裝的 URL)
      const isGasMode = serviceUrl.startsWith('GAS://');

      // 計算翻譯顯示停留時間 (GAS、本地翻譯通常不需要強制最短時間，設為 0)
      const rules = getDisplayTimeRules(sourceLang) || getDisplayTimeRules('default');
      const minDisplayTime = isGasMode || isLocalTranslationActive || isLocalPromptApiActive
        ? 0
        : rules.find(rule => text.length <= rule.maxLength).time;

      let data;

      // 5. 路由分流邏輯 (執行翻譯)
      // 優先順序: Prompt API -> 本地 Translator API -> 遠端 (GAS/Link)
      
      if (isLocalPromptApiActive && 'LanguageModel' in self) {
        // --- 分支 A: Chrome 內建 AI (Prompt API) ---
        Logger.debug('[DEBUG] [translationController.js] 執行 Prompt API 翻譯:', { sequenceId });
        try {
          data = await sendPromptTranslation(text, targetLangs, sourceLang);
        } catch (error) {
          Logger.error('[ERROR] [translationController.js] Prompt API 翻譯失敗:', { sequenceId, error: error.message });
          updateStatusDisplay('翻訳エラー (AI):', { sequenceId, error: error.message });
          // AI 失敗時給予使用者反饋，5秒後清除
          setTimeout(() => updateStatusDisplay(''), 5000);
          throw error;
        }

      } else if (isLocalTranslationActive && browserInfo.supportsTranslatorAPI) {
        // --- 分支 B: Chrome 內建翻譯 (Translator API) ---
        Logger.debug('[DEBUG] [translationController.js] 執行本地翻譯:', { sequenceId });
        data = await sendLocalTranslation(text, targetLangs, sourceLang);

      } else {
        // --- 分支 C: 遠端翻譯 (GAS 或 自訂伺服器) ---
        // 這裡會將剛才組裝好的 serviceUrl (可能是 GAS://... 或 http://...) 傳入
        // processTranslationUrl 會負責最後的解析與發送
        
        if (!serviceUrl) {
           Logger.warn('[WARN] [translationController.js] 翻譯服務網址/ID 為空，跳過請求');
           return;
        }

        // Logger.debug('[DEBUG] [translationController.js] 執行遠端翻譯:', { mode: currentMode, url: serviceUrl });
        data = await processTranslationUrl(text, targetLangs, sourceLang, serviceUrl, '', sequenceId, previousText);
      }

      // 6. 更新 UI 顯示結果
      if (data) {
        await updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId);
      } else {
        Logger.warn('[WARN] [translationController.js] 無有效翻譯結果:', { text, sequenceId });
      }

    } catch (error) {
      Logger.error('[ERROR] [translationController.js] 翻譯請求異常:', { sequenceId, error: error.message });
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
    Logger.debug('[DEBUG] [TranslationController] 清理 Translator 物件:', { cacheKey });
  });
  translatorCache.clear();
  Logger.debug('[DEBUG] [TranslationController] 清理 translatorCache');
  if (bufferCheckInterval) {
    clearInterval(bufferCheckInterval);
    bufferCheckInterval = null;
    Logger.debug('[DEBUG] [TranslationController] 清理 bufferCheckInterval');
  }
  // 清理佇列
  queue.forEach(task => task.reject(new Error('頁面即將關閉，任務被取消')));
  queue.length = 0;
  Logger.debug('[DEBUG] [TranslationController] 清理佇列');
});

export { sendTranslationRequest, sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI };