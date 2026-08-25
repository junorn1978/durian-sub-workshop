/**
 * @file translationController.js
 * @description 翻譯請求的核心。負責請求佇列、翻譯路徑分配（AI／本機／遠端），
 * 以及字幕顯示緩衝區的控制。
 * 語言資訊透過 getLang 傳回的共用語言物件處理。
 */

import { getLang, isRayModeActive } from './config.js';
import { filterTextWithKeywords, processRayModeTranscript } from './rayModeFilter.js';
import { translateWithGTX } from './gtxTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { createLogger } from './logger.js';
import { publishTranslationsToObs } from './obsBridge.js';
import { updateStatusDisplay } from './uiState.js';

const log = createLogger('TranslationController');

// #region [狀態與快取]
let sequenceCounter = 0;
let bufferCheckInterval = null;
let _cachedTargetSpans  = null;

const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };
// #endregion

// #region [並行執行控制]
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
    log.error('任務失敗:', { error: error.message });
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

// #region [翻譯請求的共用處理]

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
  if (currentMode === 'link') {
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

  } else {
    if (!serviceUrl) return null;
    const targetCodes = activeLangIds.map(id => getLang(id)?.id || id);
    data = await processTranslationUrl(text, targetCodes, sourceLangId, serviceUrl, currentMode, sequenceId, previousText);
  }

  return normalizeTranslationData(data, rawTargetLangIds, translatedLangIds);
}

// #endregion

// #region [字幕顯示緩衝區控制]
/**
 * 取得字幕顯示用的 DOM 元素。首次取得後使用快取。
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
 * 將翻譯結果加入顯示緩衝區，並更新字幕的顯示時機。
 * @param {Array<string>} targetLangIds - 目標語言 ID 清單
 */
async function updateTranslationUI(data, targetLangIds, minDisplayTime, sequenceId) {
  const stopbutton = document.getElementById('stop-recording');
  if (stopbutton.disabled) return;
  // 暫停期間仍可按下停止按鈕，因此僅靠上述判斷無法排除。
  // 防止停止前剛送出的請求回傳後覆蓋剩餘時間顯示。
  if (document.getElementById('pause-recording')?.classList.contains('is-paused')) return;

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

      // 字幕仍在最低顯示時間內時，不以後續字幕覆蓋。
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
        
        span.textContent = next.text;
        hasVisualUpdate = true;
        latestSequenceId = next.sequenceId;

        // 清空字幕（text 為空）屬於例行動作，降到 debug 免得洗版。
        const level = next.text !== '' ? 'info' : 'debug';
        log[level]('更新翻譯文字:', { text: next.text, sequenceId: next.sequenceId });
      }
    } catch (error) {
      log.error('processDisplayBuffers 錯誤:', error.message);
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
/**
 * 清空顯示緩衝區。防止停止或暫停後，緩衝區內殘留的字幕
 * 因每 500ms 執行一次的處理而延遲出現。
 */
function resetTranslationDisplay() {
  ['target1', 'target2', 'target3'].forEach(key => {
    displayBuffers[key].length = 0;
    currentDisplays[key] = null;
  });
  if (bufferCheckInterval) {
    clearInterval(bufferCheckInterval);
    bufferCheckInterval = null;
  }
}
// #endregion

// #region [翻譯請求的路徑分配]

/**
 * 傳送翻譯請求的主要入口。
 * @async
 * @param {string} sourceLangId - 來源語言 ID（例如：'ja-JP'）
 */
async function sendTranslationRequest(text, previousText = null, sourceLangId) {
  if (text === null || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') return;

  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

    try {
      // 為維持與顯示欄位的對應關係，此處也一併取得 'none'。
      const rawTargetLangIds = getConfiguredTargetLangIds();
      
      const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);

      if (activeLangIds.length === 0) return;

      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'none';

      const sourceLangObj = getLang(sourceLangId);
      const rules = sourceLangObj?.displayTimeRules || [];

      // 僅計算透過 Link 翻譯的顯示時間。gtx／Fast／Prompt 會立即更新，因此設為 0。
      const minDisplayTime = currentMode !== 'link'
                           ? 0
                           : (rules.find(rule => text.length <= rule.maxLength)?.time ?? 3);
      let data = await requestTranslationData(text, previousText, sourceLangId, rawTargetLangIds, sequenceId);

      // 後端傳來的緊急停止訊號。用於保護預算，比照使用者按下停止按鈕處理。
      // 設定 FORCE_STOP_CLIENTS=true 時，回應中會附帶 stop:true。
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
      log.error('異常:', error.message);
      updateStatusDisplay(`翻訳中にエラーが発生しました。${error.message}`);
      setTimeout(() => updateStatusDisplay(''), 5000);
      throw error;
    }
  });
}

async function translateTestText(text) {
  if (text === null || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') return null;

  return enqueue(async () => {
    const sequenceId = sequenceCounter++;
    // 文字翻譯會自動判斷輸入文字的語言（gtx 使用 source=auto）。
    // 不使用字幕的語音辨識語言，因為若與輸入語言不一致，容易原文照返或產生誤譯。
    const sourceLangId = null;
    const targetLangId = document.getElementById('text-translate-target')?.value || 'ja-JP';
    const rawTargetLangIds = [targetLangId];
    const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);

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
  if (bufferCheckInterval) clearInterval(bufferCheckInterval);
  queue.forEach(task => task.reject(new Error('頁面即將關閉')));
  queue.length = 0;
});

export { sendTranslationRequest, translateTestText, resetTranslationDisplay };
