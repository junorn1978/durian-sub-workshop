/**
 * @file translationController.js
 * @description 翻譯請求中心。負責處理請求佇列、路由分流(AI/本地/遠端)以及字幕顯示緩衝控制。
 * 2025 優化版：全面採用統一語系物件 (getLang) 模式。
 */

import { browserInfo, getLang, isRayModeActive } from './config.js';
import { filterTextWithKeywords, processRayModeTranscript } from './rayModeFilter.js';
import { destroyLocalTranslators, sendLocalTranslation } from './translatorApiService.js';
import { translateWithGTX } from './gtxTranslationService.js';
import { sendPromptTranslation } from './promptTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { isDebugEnabled } from './logger.js';
import { publishTranslationsToObs } from './obsBridge.js';
import { updateStatusDisplay } from './uiState.js';

// #region [狀態與快取]
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

// #region [翻譯請求共用核心]

function getConfiguredTargetLangIds() {
  return [
    document.getElementById('target1-language')?.value,
    document.getElementById('target2-language')?.value,
    document.getElementById('target3-language')?.value
  ];
}

function getActiveTargetLangIds(rawTargetLangIds) {
  return rawTargetLangIds.filter(id => id && id !== 'none');
}

function normalizeTranslationData(data, rawTargetLangIds, translatedLangIds) {
  if (!data?.translations) return null;

  const translations = Array.isArray(data.translations) ? data.translations : [];
  const normalized = new Array(rawTargetLangIds.length).fill('');

  if (translatedLangIds.length === rawTargetLangIds.length) {
    rawTargetLangIds.forEach((langId, index) => {
      normalized[index] = langId && langId !== 'none' ? (translations[index] || '') : '';
    });
    return { ...data, translations: normalized };
  }

  let activeIndex = 0;
  rawTargetLangIds.forEach((langId, index) => {
    if (!langId || langId === 'none') return;
    normalized[index] = translations[activeIndex] || '';
    activeIndex++;
  });

  return { ...data, translations: normalized };
}

function filterTranslationsForTargets(translations, targetLangIds) {
  return targetLangIds.map((langId, index) => {
    if (!langId || langId === 'none' || !translations[index]) return '';
    return filterTextWithKeywords(translations[index], langId);
  });
}

function resolveTranslationConfig(rawTargetLangIds) {
  const modeSelect = document.getElementById('translation-mode');
  const currentMode = modeSelect ? modeSelect.value : 'none';
  if (currentMode === 'none') throw new Error('無效的翻譯模式');

  let serviceUrl = '';
  if (currentMode === 'gas') {
    const gasId = document.getElementById('gas-script-id')?.value.trim() || '';
    if (!gasId.match(/^[a-zA-Z0-9_-]+$/)) throw new Error('無效的 Google Apps Script ID');
    serviceUrl = `https://script.google.com/macros/s/${gasId}/exec`;
  } else if (currentMode === 'link') {
    serviceUrl = document.getElementById('translation-link')?.value.trim() || '';
  }

  const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);
  if (activeLangIds.length === 0) return null;

  return { currentMode, serviceUrl, activeLangIds };
}

async function requestTranslationData(text, previousText, sourceLangId, rawTargetLangIds, sequenceId) {
  const config = resolveTranslationConfig(rawTargetLangIds);
  if (!config) return null;

  const { currentMode, serviceUrl, activeLangIds } = config;
  let data;
  let translatedLangIds = activeLangIds;

  if (currentMode === 'gtx') {
    data = await translateWithGTX(text, rawTargetLangIds, sourceLangId);
    translatedLangIds = rawTargetLangIds;

  } else if (currentMode === 'promptapi' && 'LanguageModel' in self) {
    data = await sendPromptTranslation(text, activeLangIds, sourceLangId);

  } else if (currentMode === 'fast' && browserInfo.supportsTranslatorAPI) {
    data = await sendLocalTranslation(text, activeLangIds, sourceLangId);

  } else {
    if (!serviceUrl) return null;
    const targetCodes = activeLangIds.map(id => getLang(id)?.id || id);
    data = await processTranslationUrl(text, targetCodes, sourceLangId, serviceUrl, currentMode, sequenceId, previousText);
  }

  return normalizeTranslationData(data, rawTargetLangIds, translatedLangIds);
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
        filteredText = data.translations[index];
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
  let hasVisualUpdate = false;
  let latestSequenceId = null;

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
        hasVisualUpdate = true;
        latestSequenceId = next.sequenceId;

        const level = next.text !== '' ? 'info' : 'debug';
        if (isDebugEnabled()) console[level](`[${level.toUpperCase()}] [TranslationController] 更新翻譯文字:`, { 
          text: next.text,
          sequenceId: next.sequenceId
        });
      }
    } catch (error) {
      if (isDebugEnabled()) console.error('[ERROR] [TranslationController] processDisplayBuffers 錯誤:', error.message);
    }
  });

  if (hasVisualUpdate) {
    publishTranslationsToObs([
      spans.target1?.textContent || '',
      spans.target2?.textContent || '',
      spans.target3?.textContent || ''
    ], latestSequenceId);
  }
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
      // 獲取目標語言 ID 列表 (包含 'none' 以保持索引位置，稍後過濾)
      const rawTargetLangIds = getConfiguredTargetLangIds();
      
      const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);

      if (activeLangIds.length === 0) return;

      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'none';

      const sourceLangObj = getLang(sourceLangId);
      const rules = sourceLangObj?.displayTimeRules || [];

      // サーバーサイド処理 (Link) は表示時間を計算、ローカル処理 (Fast/Prompt) は即時更新のため 0
      const minDisplayTime = currentMode !== 'link'
                           ? 0
                           : (rules.find(rule => text.length <= rule.maxLength)?.time ?? 3);
      let data = await requestTranslationData(text, previousText, sourceLangId, rawTargetLangIds, sequenceId);

      // 後端緊急停止訊號（預算保護用）。等同於使用者按下停止按鍵。
      // 觸發條件：後端設定環境變數 FORCE_STOP_CLIENTS=true 時，回應會帶 stop:true。
      if (data?.stop) {
        document.getElementById('stop-recording')?.click();
        return;
      }

      if (data) {
        data.sequenceId = sequenceId;
        data.translations = filterTranslationsForTargets(data.translations, rawTargetLangIds);
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

async function translateTestText(text) {
  if (text === null || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') return null;

  return enqueue(async () => {
    const sequenceId = sequenceCounter++;
    const sourceLangId = document.getElementById('source-language')?.value || null;
    const rawTargetLangIds = getConfiguredTargetLangIds();
    const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);

    if (!sourceLangId) throw new Error('來源語言が選択されていません');
    if (activeLangIds.length === 0) throw new Error('翻訳先言語が選択されていません');

    const sourceText = isRayModeActive() ? processRayModeTranscript(text, sourceLangId) : text;
    if (!sourceText || sourceText.trim() === '') return null;

    const data = await requestTranslationData(sourceText.trim(), null, sourceLangId, rawTargetLangIds, sequenceId);
    if (!data) return null;

    const translations = filterTranslationsForTargets(data.translations, rawTargetLangIds);
    const results = rawTargetLangIds.map((langId, index) => ({
      slot: index + 1,
      langId,
      label: langId && langId !== 'none' ? (getLang(langId)?.label || langId) : '翻訳しない',
      text: translations[index] || ''
    }));

    return {
      sequenceId,
      sourceText: sourceText.trim(),
      targetLangIds: rawTargetLangIds,
      results
    };
  });
}
// #endregion

window.addEventListener('beforeunload', () => {
  destroyLocalTranslators();
  if (bufferCheckInterval) clearInterval(bufferCheckInterval);
  queue.forEach(task => task.reject(new Error('頁面即將關閉')));
  queue.length = 0;
});

export { sendTranslationRequest, translateTestText };
