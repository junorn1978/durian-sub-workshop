/**
 * @file translatorApiService.js
 * @description Chrome 內建 Translator API (Fast 模式) 服務。
 * 實作了語言包佇列管理、下載進度監控、以及專為日文語音辨識優化的標點符號預處理。
 */

import { getLang, getSourceLanguage } from './config.js';
import { sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI } from './translationController.js';
import { Logger } from './logger.js';

// #region [全域狀態與佇列]
/** @type {Array<Object>} 待下載的語言對佇列 */
let downloadQueue = [];

/** @type {boolean} 佇列是否已執行過初始化掃描 */
let isQueueInitialized = false;
// #endregion

// #region [UI 監控與初始化]

/**
 * 檢查目前選擇的語系組合是否需要下載模型，並更新 UI。
 * 可由外部 (uiController) 在模式切換或語系變更時主動呼叫。
 * @async
 */
export async function checkTranslationAvailability() {
  const downloadBtn = document.getElementById('fast-mode-download-btn');
  const progressSpan = document.getElementById('fast-mode-progress');
  if (!downloadBtn || !progressSpan) return;

  const sourceLang = await getSourceLanguage();
  const targetLangs = [
    document.getElementById('target1-language')?.value,
    document.getElementById('target2-language')?.value,
    document.getElementById('target3-language')?.value
  ].filter(lang => lang && lang !== 'none');

  // 若沒選完整語系，直接清空狀態
  if (!sourceLang || targetLangs.length === 0) {
    downloadQueue = [];
    progressSpan.textContent = '語系を選択してください';
    downloadBtn.textContent = 'ダウンロード';
    return;
  }

  progressSpan.textContent = '確認中...';
  const sourceCodeObj = getLang(sourceLang);
  if (!sourceCodeObj) { Logger.error("找不到來源語系物件"); return; }
  
  const sourceCode = sourceCodeObj.languageModelApiCode;
  const newQueue = [];

  for (const lang of targetLangs) {
    if (!lang) continue;
    const targetCodeObj = getLang(lang);
    const targetCode = targetCodeObj.languageModelApiCode;
    const targetCodeLabel = targetCodeObj.label

    try {
      const availability = await Translator.availability({ sourceLanguage: sourceCode, targetLanguage: targetCode });
      
      // 僅將需要下載的加入佇列
      if (availability === 'downloadable' || availability === 'downloading') {
        newQueue.push({ source: sourceCode, target: targetCode, label: targetCodeLabel });
      }
    } catch (e) {
      Logger.warn(`[Translator API] 語系 ${sourceCode}->${targetCode} 狀態檢查失敗`);
    }
  }

  downloadQueue = newQueue;
  updateQueueUI(downloadBtn, progressSpan);
}

/**
 * 監聽 Fast 模式按鈕並初始化偵測
 */
export function monitorLocalTranslationAPI() {
  const downloadBtn = document.getElementById('fast-mode-download-btn');
  const progressSpan = document.getElementById('fast-mode-progress');
  if (!downloadBtn) return;

  downloadBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    
    // 點擊時若佇列為空，先嘗試重新偵測
    if (downloadQueue.length === 0) {
      await checkTranslationAvailability();
    }

    if (downloadQueue.length > 0) {
      const { source, target, label } = downloadQueue[0];
      downloadBtn.disabled = true;
      const success = await ensureModelLoaded(source, target, label);
      if (success) downloadQueue.shift();
      downloadBtn.disabled = false;
      updateQueueUI(downloadBtn, progressSpan);
    }
  });

  // 初次執行偵測
  checkTranslationAvailability();
}

/** 更新 UI 狀態文字 */
function updateQueueUI(btn, span) {
  if (downloadQueue.length === 0) {
    btn.textContent = '完了';
    span.textContent = '準備完了 (All Ready)';
    setTimeout(() => { if (span.textContent.includes('Ready')) span.textContent = '準備完了'; }, 3000);
  } else {
    btn.textContent = `次へ (${downloadQueue.length})`;
    span.textContent = `ダウンロード待機中: ${downloadQueue[0].label}`;
  }
}

/** 執行下載邏輯 */
async function ensureModelLoaded(sourceLanguage, targetLanguage, label) {
  const progressSpan = document.getElementById('fast-mode-progress');
  try {
    const availability = await Translator.availability({ sourceLanguage, targetLanguage });
    if (availability === 'available') return true;

    await Translator.create({
      sourceLanguage, targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const progress = Math.round(e.loaded * 100);
          if (progressSpan) progressSpan.textContent = `${label} ダウンロード中: ${progress}%`;
        });
      }
    });
    return true;
  } catch (error) {
    Logger.error('[Translator API] 下載失敗:', error);
    if (progressSpan) progressSpan.textContent = 'ダウンロード失敗';
    return false;
  }
}
// #endregion

// #region [翻譯執行與預處理]

/**
 * 使用本地端 Translator API 進行翻譯 (Fast 模式)
 * @async
 * @param {string} text - 原始辨識文字
 * @param {string[]} targetLangs - 目標語系代碼列表
 * @param {string} sourceLang - 來源語系
 * @returns {Promise<Object|null>}
 */
export async function sendLocalTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ') return null;

  const sourceLangObj = getLang(sourceLang);
  if (!sourceLangObj) { Logger.error ("找不到來源語系物件"); return null; };
  const sourceLanguage = sourceLangObj.languageModelApiCode;

  // 日文語音辨識通常缺乏標點，透過預處理器補強以提升翻譯品質
  let processedText = text;
  if (sourceLanguage === 'ja') {
    processedText = preprocessJapaneseText(text);
  }

  Logger.debug('[DEBUG] [Translator API] 翻譯前文字:', processedText);
  const translations = new Array(targetLangs.length).fill('');

  for (let i = 0; i < targetLangs.length; i++) {
    const targetLangObj = getLang((targetLangs[i]));
    if (!targetLangObj) continue;
    const targetLanguage = targetLangObj.languageModelApiCode
    const cacheKey = `${sourceLanguage}-${targetLanguage}`;

    try {
      const availability = await Translator.availability({ sourceLanguage, targetLanguage });
      if (availability !== 'available') continue;

      let translator = translatorCache.get(cacheKey);
      if (!translator) {
        translator = await Translator.create({ sourceLanguage, targetLanguage });
        translatorCache.set(cacheKey, translator);
      }

      translations[i] = await translator.translate(processedText);
    } catch (error) {
      Logger.error('[ERROR] [Translator API] 翻譯異常:', error);
    }
  }

  return { translations };
}

/**
 * 日文文字預處理：針對缺乏標點的語音辨識文字，根據詞綴與句尾形式進行智慧補點。
 * @param {string} text 
 * @returns {string} 補點後的日文內容
 */
function preprocessJapaneseText(text) {
    if (typeof text !== 'string' || text.trim().length < 5) return text;
    
    // 定義常見句尾與助詞以判斷斷句點
    const END_FORMS = new Set(['です', 'ます', 'だ', 'である', 'でした', 'だった', 'でしょう', 'だろう', 'ですよ', 'ですね', 'ますね', 'かも', 'かな']);
    const MID_PARTS = new Set(['は','が','を','に','で','と','へ','や','から','まで','も','より','しか','こそ','でも','など','ね','よ']);
    
    const tokens = text.trim().split(/\s+/u);
    if (tokens.length === 1) return text;

    let hasEndForm = false;
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (!tk) continue;
      const base = tk.replace(/[。！？!?、，｡､]+$/gu, '');
      
      if (i === tokens.length - 1) {
        if (END_FORMS.has(base)) { tokens[i] = `${base}。`; hasEndForm = true; } 
        else { tokens[i] = `${tk}。`; }
        continue;
      }
      if (MID_PARTS.has(base)) { tokens[i] = `${base}、`; }
      if (END_FORMS.has(base)) { tokens[i] = `${base}。`; hasEndForm = true; }
    }
    
    let processed = tokens.join(' ');
    
    // 若無明確句尾形式，針對片假名與外來語混合排版進行二次處理
    if (!hasEndForm) {
      const isKatakanaOrEnglish = /^[\u30A0-\u30FF\uFF00-\uFFEF\uFF65-\uFF9F\uFF9E\uFF9F]+|[A-Za-z]+$/u;
      const newTokens = [];
      for (let j = 0; j < tokens.length; j++) {
        if (j === 0) { newTokens.push(tokens[j]); continue; }
        const prevToken = tokens[j - 1];
        const currToken = tokens[j];
        if (isKatakanaOrEnglish.test(prevToken.replace(/[。！？!?、，｡､]+$/gu, '')) && 
            isKatakanaOrEnglish.test(currToken.replace(/[。！？!?、，｡､]+$/gu, ''))) {
          newTokens.push(' ' + currToken);
        } else {
          newTokens[newTokens.length - 1] += '、';
          newTokens.push(currToken.replace(/^[、\s]+/gu, ''));
        }
      }
      processed = newTokens.join('').trim();
    }
    return processed;
}
// #endregion