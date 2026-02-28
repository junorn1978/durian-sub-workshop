/**
 * @file translationController.js
 * @description 翻譯請求中心。負責處理請求佇列、路由分流(AI/本地/遠端)以及字幕顯示緩衝控制。
 * 2025 優化版：全面採用統一語系物件 (getLang) 模式。
 */

import { keywordRules } from './speechCapture.js';
import { browserInfo, getLang, isRayModeActive, isDeepgramActive } from './config.js';
import { sendLocalTranslation } from './translatorApiService.js';
import { translateWithGTX } from './gtxTranslationService.js';
import { sendPromptTranslation } from './promptTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { isDebugEnabled } from './logger.js';

// #region [狀態與快取]
const translatorCache = new Map();
let sequenceCounter = 0;
let bufferCheckInterval = null;
let _cachedTargetSpans  = null;

const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };
// #endregion

// #region [併發控制]
const queue = [];
let inFlight = 0;
const MAX = 5;

export function enqueue(task) {
  const { promise, resolve, reject } = Promise.withResolvers();
  queue.push({ task, resolve, reject });
  pump();
  return promise;
}

async function processTask(next) {
  inFlight++;
  try {
    const result = await next.task();
    next.resolve(result);
  } catch (error) {
    if (isDebugEnabled()) console.error('[ERROR] [TranslationController] 任務失敗:', { error: error.message });
    next.reject(error);
  } finally {
    inFlight--;
    pump();
  }
}

function pump() {
  while (inFlight < MAX && queue.length > 0) {
    const next = queue.shift();
    processTask(next);
  }
}
// #endregion

// #region [文字處理與過濾]

/**
 * 針對翻譯後的結果進行 Ray Mode 關鍵字過濾
 * @param {string} text 
 * @param {string} targetLangId - 傳入目標語言 ID 
 */
function filterTextWithKeywords(text, targetLangId) {
  if (!isRayModeActive()) return text;

  let result = text.replace(/"/g, ''); 

  const cachedRules = new Map();
  if (!cachedRules.has(targetLangId)) {
    cachedRules.set(targetLangId, keywordRules
      .filter(rule => rule.lang === targetLangId)
      .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
  }
  cachedRules.get(targetLangId)?.forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });
  return result;
}

function updateStatusDisplay(text, details = null) {
  const statusDisplay = document.getElementById('status-display');
  let displayText = text;
  if (details) {
    const detailStrings = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(', ');
    displayText = `${text} ${detailStrings}`;
  }
  if (statusDisplay && statusDisplay.textContent !== displayText) {
    statusDisplay.textContent = displayText;
  }
}
// #endregion

// #region [緩衝顯示控制 (Subtitle Timing)]
/**
 * 取得字幕顯示元素 (含快取機制)
 * 
 */
function getTargetSpans() {
  if (!_cachedTargetSpans) {
    _cachedTargetSpans = {
      target1: document.getElementById('target-text-1'),
      target2: document.getElementById('target-text-2'),
      target3: document.getElementById('target-text-3')
    };
  }
  return _cachedTargetSpans;
}

/**
 * 更新翻譯 UI 的緩衝邏輯
 * @param {Array<string>} targetLangIds - 目標語言 ID 列表
 */
async function updateTranslationUI(data, targetLangIds, minDisplayTime, sequenceId) {
  const stopbutton = document.getElementById('stop-recording');
  if (stopbutton.disabled) return;

  const spans = getTargetSpans();

  targetLangIds.forEach((langId, index) => {
    const targetKey = `target${index + 1}`;
    const span = spans[targetKey];
    if (span) {
      let filteredText = '';
      if (langId && langId !== 'none' && data?.translations && data.translations[index]) {
        filteredText = filterTextWithKeywords(data.translations[index], langId);
      }
      
      displayBuffers[targetKey].push({
        text: filteredText,
        minDisplayTime,
        sequenceId: data.sequenceId ?? sequenceId,
        timestamp: Date.now()
      });
    }
  });

  processDisplayBuffers();
  if (!bufferCheckInterval) {
    bufferCheckInterval = setInterval(processDisplayBuffers, 500);
  }
}

function processDisplayBuffers() {
  const now = Date.now();
  const spans = getTargetSpans();

  ['target1', 'target2', 'target3'].forEach(key => {
    const span = spans[key];
    if (!span || displayBuffers[key].length === 0) return;

    try {
      const buffer = displayBuffers[key];

      let validStartIndex = 0;
      while (validStartIndex < buffer.length) {
        if (now - buffer[validStartIndex].timestamp < 10000) break;
        validStartIndex++;
      }
      if (validStartIndex > 0) { buffer.splice(0, validStartIndex); }
      if (buffer.length > 1  ) { buffer.sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0)); }
      if (buffer.length > 10 ) { buffer.splice(0, buffer.length - 10); }
      if (buffer.length === 0) return;

      // --- 顯示判斷邏輯 ---
      if (currentDisplays[key] && now - currentDisplays[key].startTime < currentDisplays[key].minDisplayTime * 1000) {
        return;
      }

      const lastSequenceId = currentDisplays[key]?.sequenceId ?? -1;
      const nextIndex = buffer.findIndex(item => item.sequenceId > lastSequenceId);
      
      if (nextIndex !== -1) {
        const next = buffer.splice(nextIndex, 1)[0];
        
        currentDisplays[key] = {
          text: next.text,
          startTime: now,
          minDisplayTime: next.minDisplayTime,
          sequenceId: next.sequenceId
        };
        
        // 更新 DOM
        span.textContent = next.text;

        const level = next.text !== '' ? 'info' : 'debug';
        console[level](`[${level.toUpperCase()}] [TranslationController] 更新翻譯文字:`, { 
          text: next.text,
          sequenceId: next.sequenceId
        });
      }
    } catch (error) {
      if (isDebugEnabled()) console.error('[ERROR] [TranslationController] processDisplayBuffers 錯誤:', error.message);
    }
  });
}
// #endregion

// #region [翻譯請求核心 (路由分流)]

/**
 * 發送翻譯請求的主進入點
 * @async
 * @param {string} sourceLangId - 來源語言 ID (如 'ja-JP')
 */
async function sendTranslationRequest(text, previousText = null, sourceLangId) {
  if (text === null || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') return;

  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

    try {
      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'none';
      if (currentMode === 'none') { if (isDebugEnabled()) console.error('[ERROR] [TranslationController], 無效的翻譯模式'); return; }

      let serviceUrl = '';

      // --- 模式參數檢查 ---
      if (currentMode === 'gas') {
        const gasId = document.getElementById('gas-script-id')?.value.trim() || '';
        if (!gasId.match(/^[a-zA-Z0-9_-]+$/)) {
          if (isDebugEnabled()) console.error('[ERROR] [TranslationController], 無效的 GAS ID');
          updateStatusDisplay('無效的 Google Apps Script ID');
          setTimeout(() => updateStatusDisplay(''), 5000);
          return;
        }
        serviceUrl = `https://script.google.com/macros/s/${gasId}/exec`;

      } else if (currentMode === 'link') {
        serviceUrl = document.getElementById('translation-link')?.value.trim() || '';
      }
      // 獲取目標語言 ID 列表 (包含 'none' 以保持索引位置，稍後過濾)
      const rawTargetLangIds = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ];
      
      const activeLangIds = rawTargetLangIds.filter(id => id && id !== 'none');

      if (activeLangIds.length === 0) return;

      const sourceLangObj = getLang(sourceLangId);
      const rules = sourceLangObj?.displayTimeRules || [];

      // サーバーサイド処理 (Link) は表示時間を計算、ローカル処理 (Fast/Prompt) は即時更新のため 0
      const minDisplayTime = currentMode !== 'link'
                           ? 0
                           : (rules.find(rule => text.length <= rule.maxLength)?.time ?? 3);
      let data;

      // --- 路由分流 (Routing) ---

      if (currentMode === 'gtx') {
        data = await translateWithGTX(text, rawTargetLangIds, sourceLangId);

      } else if (currentMode === 'prompt' && 'LanguageModel' in self) {
        data = await sendPromptTranslation(text, activeLangIds, sourceLangId);

      } else if (currentMode === 'fast' && browserInfo.supportsTranslatorAPI) {
        data = await sendLocalTranslation(text, activeLangIds, sourceLangId);

      } else {
        if (!serviceUrl) return;
        const targetCodes = activeLangIds.map(id => getLang(id)?.id || id);
        data = await processTranslationUrl(text, targetCodes, sourceLangId, serviceUrl, currentMode, sequenceId, previousText);
      }

      if (data) {
        data.sequenceId = sequenceId;
        await updateTranslationUI(data, rawTargetLangIds, minDisplayTime, sequenceId);
      }
    } catch (error) {
      if (isDebugEnabled()) console.error('[ERROR] [translationController] 異常:', error.message);
      updateStatusDisplay('翻訳エラー:', { error: error.message });
      setTimeout(() => updateStatusDisplay(''), 5000);
      throw error;
    }
  });
}
// #endregion

window.addEventListener('beforeunload', () => {
  translatorCache.forEach((t) => { try { t.destroy(); } catch (e) {} });
  translatorCache.clear();
  if (bufferCheckInterval) clearInterval(bufferCheckInterval);
  queue.forEach(task => task.reject(new Error('頁面即將關閉')));
  queue.length = 0;
});

export { sendTranslationRequest, sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI };