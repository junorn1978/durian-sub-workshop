// translatorApiService.js
import { getLanguageModelApiCode } from './config.js';
import { sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI } from './translationController.js';
import { Logger } from './logger.js';

// 用來追蹤待下載的語言對佇列
let downloadQueue = [];
let isQueueInitialized = false;

// 監聽 local-translation-api 狀態與綁定下載按鈕
function monitorLocalTranslationAPI() {
  const downloadBtn = document.getElementById('fast-mode-download-btn');
  const progressSpan = document.getElementById('fast-mode-progress');

  if (!downloadBtn) {
    Logger.debug('[DEBUG] [Translator API] 未找到 fast-mode-download-btn 元素');
    return;
  }

  // 處理點擊事件：這是唯一的驅動入口
  const handleDownloadClick = async () => {
    // 1. 如果佇列尚未初始化（第一次點擊），先掃描所有語言
    if (!isQueueInitialized) {
      await initializeQueue(progressSpan);
      isQueueInitialized = true;
    }

    // 2. 檢查佇列狀態
    if (downloadQueue.length === 0) {
      // 再次確認狀態 (防止使用者切換語言後再次點擊)
      await initializeQueue(progressSpan); 
      
      // [修正] 判斷是「全部下載完」還是「根本沒選語言」
      const targetLangs = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ].filter(lang => lang && lang !== 'none');

      if (targetLangs.length === 0) {
        if (progressSpan) progressSpan.textContent = '言語を選択してください';
        return; // 沒選語言，直接結束，不顯示 Ready
      }

      // 確實有選語言，且佇列為空 -> 代表全部已就緒
      if (downloadQueue.length === 0) {
        if (progressSpan) progressSpan.textContent = '準備完了 (All Ready)';
        return;
      }
    }

    // 3. 取出下一個要下載的任務
    const nextTask = downloadQueue[0]; // 先不移除，等下載成功再移除
    const { source, target, label } = nextTask;

    // 更新按鈕狀態
    downloadBtn.disabled = true; 
    
    try {
      // 執行下載
      const success = await ensureModelLoaded(source, target, label);
      
      if (success) {
        // 下載成功，從佇列移除
        downloadQueue.shift();
      } else {
        Logger.error(`[ERROR] [Translator API] ${label} 下載失敗`);
      }

    } catch (e) {
      Logger.error('[ERROR] [Translator API] 下載過程發生錯誤:', e);
    } finally {
      // 4. 下載結束後的 UI 更新
      downloadBtn.disabled = false;
      updateQueueUI(downloadBtn, progressSpan);
    }
  };
  
  // 綁定按鈕點擊事件
  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDownloadClick();
  });
}

// 初始化佇列：檢查哪些語言還沒下載
async function initializeQueue(progressSpan) {
  if (progressSpan) progressSpan.textContent = '確認中...';
  
  const sourceLang = document.getElementById('source-language')?.value;
  const targetLangs = [
    document.getElementById('target1-language')?.value,
    document.getElementById('target2-language')?.value,
    document.getElementById('target3-language')?.value
  ].filter(lang => lang && lang !== 'none');

  if (!sourceLang || targetLangs.length === 0) {
    if (progressSpan) progressSpan.textContent = '言語を選択してください';
    downloadQueue = [];
    return;
  }

  const sourceCode = getLanguageModelApiCode(sourceLang);
  downloadQueue = []; // 重置佇列

  // 檢查每一個目標語言
  for (const lang of targetLangs) {
    const targetCode = getLanguageModelApiCode(lang);
    try {
      const availability = await Translator.availability({ sourceLanguage: sourceCode, targetLanguage: targetCode });
      
      if (availability === 'available') {
        Logger.debug(`[DEBUG] [Translator API] ${sourceCode}->${targetCode} 已就緒`);
      } else if (availability === 'no') {
        Logger.warn(`[WARN] [Translator API] ${sourceCode}->${targetCode} 不支援`);
      } else {
        // 需要下載 (downloadable 或 downloading)
        downloadQueue.push({
          source: sourceCode,
          target: targetCode,
          label: `${targetCode}` // 顯示用的簡稱
        });
      }
    } catch (e) {
      Logger.warn(`[WARN] [Translator API] 檢查 ${sourceCode}->${targetCode} 失敗:`, e);
    }
  }

  Logger.debug('[DEBUG] [Translator API] 下載佇列初始化:', downloadQueue);
}

// 更新按鈕與文字狀態
function updateQueueUI(btn, span) {
  if (downloadQueue.length === 0) {
    // 這裡也要做防呆，避免最後一個下載完後文字顯示錯誤
    // 但因為 handleDownloadClick 會再次檢查，這裡主要負責下載成功後的恢復
    const targetLangs = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ].filter(lang => lang && lang !== 'none');

    if (targetLangs.length === 0) {
         span.textContent = '言語を選択してください';
         btn.textContent = 'モデルDL';
         return;
    }

    btn.textContent = 'モデルDL'; // 恢復預設
    span.textContent = '準備完了 (All Ready)';
    
    // 3秒後清除
    setTimeout(() => { if (span.textContent.includes('Ready')) span.textContent = '準備完了'; }, 3000);
  } else {
    // 還有剩餘任務
    const nextItem = downloadQueue[0];
    const remainingCount = downloadQueue.length;
    
    // 按鈕變成引導使用者點擊
    btn.textContent = `次へ (${remainingCount})`;
    span.textContent = `待機中: ${nextItem.label}`;
  }
}

// 確保語言模型已載入 (單次下載邏輯)
async function ensureModelLoaded(sourceLanguage, targetLanguage, label = '') {
  const progressSpan = document.getElementById('fast-mode-progress');
  const pairName = label || `${sourceLanguage}->${targetLanguage}`;
  
  try {
    const availability = await Translator.availability({ sourceLanguage, targetLanguage });
    
    if (availability === 'available') {
      return true; // 已經好了
    }
    
    // 開始下載
    Logger.debug(`[DEBUG] [Translator API] 開始下載 ${pairName}`);
    if (progressSpan) progressSpan.textContent = `${pairName} DL開始...`;
    
    await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const progress = Math.round(e.loaded * 100);
          if (progressSpan) {
             progressSpan.textContent = `${pairName} DL: ${progress}%`;
          }
        });
      }
    });

    Logger.info(`[INFO] [Translator API] ${pairName} 下載完成`);
    return true;

  } catch (error) {
    Logger.error('[ERROR] [Translator API] 下載失敗:', error);
    
    if (error.name === 'NotAllowedError') {
       if (progressSpan) progressSpan.textContent = 'クリックが必要です';
       alert('ブラウザのセキュリティ制限により、モデルのダウンロードにはクリックが必要です。\nもう一度「次へ」ボタンを押してください。');
    } else {
       if (progressSpan) progressSpan.textContent = `エラー: ${error.message}`;
    }
    return false;
  }
}

// 預下載語言模型 (此函式現在只做檢查，不再負責下載迴圈)
async function preloadTranslationModels(sourceLang, targetLangs) {
  const progressSpan = document.getElementById('fast-mode-progress');
  if (progressSpan) progressSpan.textContent = 'ボタンを押してDLしてください';
}

// 使用 Chrome Translator API 進行翻譯
async function sendLocalTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    return null;
  }

  const sourceLanguageCode = getLanguageModelApiCode(sourceLang);
  if (sourceLanguageCode === 'ja') {
    text = preprocessJapaneseText(text);
  }

  const translations = new Array(targetLangs.length).fill('');
  let allAvailable = true;

  for (let i = 0; i < targetLangs.length; i++) {
    const sourceLanguage = getLanguageModelApiCode(sourceLang);
    const targetLanguage = getLanguageModelApiCode(targetLangs[i]);
    const cacheKey = `${sourceLanguage}-${targetLanguage}`;

    try {
      const availability = await Translator.availability({ sourceLanguage, targetLanguage });
      if (availability !== 'available') {
        Logger.warn(`[WARN] [Translator API] ${sourceLanguage}->${targetLanguage} 未就緒，跳過翻譯`);
        allAvailable = false;
        continue;
      }

      let translator = translatorCache.get(cacheKey);
      if (!translator) {
        translator = await Translator.create({ sourceLanguage, targetLanguage });
        translatorCache.set(cacheKey, translator);
      }

      const result = await translator.translate(text);
      translations[i] = result;
    } catch (error) {
      Logger.error('[ERROR] [Translator API] 翻譯異常:', error);
      translations[i] = '';
    }
  }

  if (translations.some(t => t !== '')) {
    await updateTranslationUI(
      { translations, sequenceId: sequenceCounter },
      targetLangs,
      0, 
      sequenceCounter
    );
  }

  return { translations, sequenceId: sequenceCounter };
}

// 文字翻譯前的語句標點符號加入
function preprocessJapaneseText(text) {
    if (typeof text !== 'string' || text.trim().length < 5) return text;
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

export { monitorLocalTranslationAPI, sendLocalTranslation };