/**
 * @file translationController.js
 * @description 翻譯請求中心。負責處理請求佇列、路由分流(AI/本地/遠端)以及字幕顯示緩衝控制。
 * 2025 優化版：全面採用統一語系物件 (getLang) 模式。
 */

import { keywordRules } from './speechCapture.js';
import { browserInfo, getLang, isRayModeActive, isDeepgramActive } from './config.js'; // [修改] 統一引入 getLang
import { sendLocalTranslation } from './translatorApiService.js';
import { sendPromptTranslation } from './promptTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { Logger } from './logger.js';

// #region [狀態與快取]
const translatorCache = new Map();
let sequenceCounter = 0;
let bufferCheckInterval = null;
let _cachedTargetSpans  = null;
let _cachedLangInputs   = null;

const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };
// #endregion

// #region [併發控制 (維持不變)]
const queue = [];
let inFlight = 0;
const MAX = 5;

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

async function pump() {
  if (inFlight >= MAX) return;
  const next = queue.shift();
  if (!next) return;
  inFlight++;
  try {
    next.resolve(await next.task());
  } catch (e) {
    Logger.error('[ERROR] [TranslationController] 任務失敗:', { error: e.message });
    next.reject(e);
  } finally {
    inFlight--;
    pump();
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

  // [修改] 這裡的快取機制可保留，但比對時統一使用 ID
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
    statusDisplay.dataset.stroke = displayText;
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
function getLangInputs() {
  if (!_cachedLangInputs) {
    _cachedLangInputs = {
      target1: document.getElementById('target1-language'),
      target2: document.getElementById('target2-language'),
      target3: document.getElementById('target3-language')
    };
  }
  return _cachedLangInputs;
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
    const span = spans[`target${index + 1}`];
    if (span && data?.translations && data.translations[index]) {
      const filteredText = filterTextWithKeywords(data.translations[index], langId);
      
      displayBuffers[`target${index + 1}`].push({
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
  // [優化 1] 取得 DOM 快取，避免重複查詢
  const spans = getTargetSpans();
  const langInputs = getLangInputs(); 

  ['target1', 'target2', 'target3'].forEach(key => {
    const span = spans[key];
    // 檢查 buffer 是否為空，若為空直接跳過，省去後續計算
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
        span.dataset.stroke = next.text;

        span.getAnimations?.().forEach(a => a.cancel());
        span.classList.remove('flash');
        requestAnimationFrame(() => span.classList.add('flash'));

        const langId = langInputs[key]?.value; 
        const langObj = getLang(langId);
        const chunkSize = langObj?.chunkSize || 40;
        span.classList.toggle('multi-line', next.text.length > chunkSize);

        Logger.info('[INFO] [TranslationController] 更新翻譯文字:', { 
          text: next.text,
          id: langId,
          sequenceId: next.sequenceId
        });
      }
    } catch (error) {
      Logger.error('[ERROR] [TranslationController] processDisplayBuffers 錯誤:', error.message);
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
  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

    try {
      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'none';
      if (currentMode === 'none') { Logger.error('[ERROR] [TranslationController], 無效的翻譯模式'); return; }

      let serviceUrl = '';

      if (currentMode === 'gas') {
        const gasId = document.getElementById('gas-script-id')?.value.trim() || '';
        if (!gasId.match(/^[a-zA-Z0-9_-]+$/)) {
          Logger.error('[ERROR] [TranslationController], 無效的 GAS ID:', gasId);
          updateStatusDisplay('無效的 Google Apps Script ID');
          setTimeout(() => updateStatusDisplay(''), 5000);
          return;
        }
        serviceUrl = `https://script.google.com/macros/s/${gasId}/exec`;

      } else if (currentMode === 'link') {
        serviceUrl = document.getElementById('translation-link')?.value.trim() || '';
      }

      // [修改] 獲取目標語言 ID 列表
      const targetLangIds = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ].filter(id => id && id !== 'none');

      if (targetLangIds.length === 0) return;

      // [修改] 取得來源語系物件以獲取時長規則
      const sourceLangObj = getLang(sourceLangId);
      const rules = sourceLangObj?.displayTimeRules || [];

      const minDisplayTime = (currentMode !== 'link' || isDeepgramActive())
        ? 0
        : (rules.find(rule => text.length <= rule.maxLength)?.time || 3);

      let data;

      // --- 路由分流 ---

      if (currentMode === 'prompt' && 'LanguageModel' in self) {
        // 分支 A: AI 模式 (傳遞 IDs，由 Service 內部處理物件取值)
        data = await sendPromptTranslation(text, targetLangIds, sourceLangId);

      } else if (currentMode === 'fast' && browserInfo.supportsTranslatorAPI) {
        // 分支 B: Fast 模式 (準備改為傳遞 IDs)
        data = await sendLocalTranslation(text, targetLangIds, sourceLangId);

      } else {
        // 分支 C: 遠端模式 (需要轉換為 API 代碼以便後端識別)
        if (!serviceUrl) return;
        const targetCodes = targetLangIds.map(id => getLang(id)?.id || id);
        data = await processTranslationUrl(text, targetCodes, sourceLangId, serviceUrl, currentMode, sequenceId, previousText);
      }

      if (data) {
        await updateTranslationUI(data, targetLangIds, minDisplayTime, sequenceId);
      }
    } catch (error) {
      Logger.error('[ERROR] [translationController.js] 異常:', error.message);
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