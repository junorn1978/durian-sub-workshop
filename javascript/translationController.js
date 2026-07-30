/**
 * @file translationController.js
 * @description 翻訳リクエストの中枢。リクエストキュー、翻訳ルートの振り分け(AI/ローカル/リモート)、
 * 字幕表示用バッファの制御を担当する。
 * 言語情報は getLang による共通の言語オブジェクトで扱う。
 */

import { getLang, isRayModeActive } from './config.js';
import { filterTextWithKeywords, processRayModeTranscript } from './rayModeFilter.js';
import { translateWithGTX } from './gtxTranslationService.js';
import { processTranslationUrl } from './remoteTranslationService.js';
import { isDebugEnabled } from './logger.js';
import { publishTranslationsToObs } from './obsBridge.js';
import { updateStatusDisplay } from './uiState.js';

// #region [状態とキャッシュ]
let sequenceCounter = 0;
let bufferCheckInterval = null;
let _cachedTargetSpans  = null;

const displayBuffers = { target1: [], target2: [], target3: [] };
const currentDisplays = { target1: null, target2: null, target3: null };
// #endregion

// #region [同時実行制御]
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

// #region [翻訳リクエストの共通処理]

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

// #region [字幕表示バッファ制御]
/**
 * 字幕表示用の DOM 要素を取得する。初回取得後はキャッシュを使う。
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
 * 翻訳結果を表示バッファへ追加し、字幕の表示タイミングを更新する。
 * @param {Array<string>} targetLangIds - 翻訳先言語 ID の一覧
 */
async function updateTranslationUI(data, targetLangIds, minDisplayTime, sequenceId) {
  const stopbutton = document.getElementById('stop-recording');
  if (stopbutton.disabled) return;
  // 一時停止中は停止ボタンを押せる状態にしてあるため、上の判定だけでは弾けない。
  // 停止直前に投げたリクエストの返りが残り時間表示を上書きしないようにする。
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

      // 最低表示時間が残っている字幕は、次の字幕で上書きしない。
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
/**
 * 表示バッファを空にする。停止・一時停止のあとに、バッファに残っていた字幕が
 * 500ms ごとの処理で遅れて出てくるのを防ぐ。
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

// #region [翻訳リクエストのルート振り分け]

/**
 * 翻訳リクエストを送信するための主な入口。
 * @async
 * @param {string} sourceLangId - 翻訳元言語 ID (例: 'ja-JP')
 */
async function sendTranslationRequest(text, previousText = null, sourceLangId) {
  if (text === null || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') return;

  return enqueue(async () => {
    const sequenceId = sequenceCounter++;

    try {
      // 表示スロットとの対応を保つため、ここでは 'none' も含めて取得する。
      const rawTargetLangIds = getConfiguredTargetLangIds();
      
      const activeLangIds = getActiveTargetLangIds(rawTargetLangIds);

      if (activeLangIds.length === 0) return;

      const modeSelect = document.getElementById('translation-mode');
      const currentMode = modeSelect ? modeSelect.value : 'none';

      const sourceLangObj = getLang(sourceLangId);
      const rules = sourceLangObj?.displayTimeRules || [];

      // Link 経由の翻訳だけ表示時間を計算する。gtx/Fast/Prompt は即時更新なので 0 にする。
      const minDisplayTime = currentMode !== 'link'
                           ? 0
                           : (rules.find(rule => text.length <= rule.maxLength)?.time ?? 3);
      let data = await requestTranslationData(text, previousText, sourceLangId, rawTargetLangIds, sequenceId);

      // バックエンドからの緊急停止信号。予算保護用で、ユーザーが停止ボタンを押した場合と同じ扱いにする。
      // FORCE_STOP_CLIENTS=true が設定されていると、レスポンスに stop:true が付く。
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
    // テキスト翻訳では入力テキストの言語を自動判定する（gtx は source=auto）。
    // 字幕用の音声認識言語は使わない。入力言語と一致しない場合、原文返しや誤訳になりやすいため。
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
