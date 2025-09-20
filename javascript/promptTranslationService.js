import { getPromptApiCode } from './config.js';

// 全局語言模型工作階段快取
const languageModelSessions = new Map();

// 確保語言模型已載入
async function ensureModelLoaded(sourceLanguage, targetLanguage) {
  try {
    console.debug('[DEBUG] [PromptAPI] 檢查語言模型可用性:', { sourceLanguage, targetLanguage });
    const availability = await LanguageModel.availability();
    if (availability === 'available') {
      console.info('[INFO] [PromptAPI] 語言模型已準備好:', { sourceLanguage, targetLanguage });
      return true;
    }
    if (availability !== 'downloadable') {
      console.error('[ERROR] [PromptAPI] 語言模型不可下載:', { availability });
      return false;
    }

    // 下載邏輯由外部按鈕觸發，這裡僅檢查
    await new Promise(resolve => setTimeout(resolve, 1000)); // 簡化等待，實際應監聽事件
    const newAvailability = await LanguageModel.availability();
    if (newAvailability === 'available') {
      console.info('[INFO] [PromptAPI] 語言模型下載完成:', { sourceLanguage, targetLanguage });
      return true;
    } else {
      console.error('[ERROR] [PromptAPI] 語言模型下載失敗:', { sourceLanguage, targetLanguage });
      return false;
    }
  } catch (error) {
    console.error('[ERROR] [PromptAPI] 語言模型載入失敗:', { sourceLanguage, targetLanguage, error: error.message });
    return false;
  }
}

// 使用 Prompt API 進行翻譯
async function sendPromptTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [promptTranslationService.js]', '無效文字，跳過翻譯:', text);
    return null;
  }

  const translations = new Array(targetLangs.length).fill('');
  const sourceLanguage = getPromptApiCode(sourceLang);
  const targetLanguages = targetLangs.map(lang => getPromptApiCode(lang));
  const cacheKey = `${sourceLanguage}-${targetLanguages.join('-')}`;
  let hasErrors = false;

  try {
    // 為每個目標語言並行檢查模型可用性並進行翻譯
    const translationPromises = targetLanguages.map(async (targetLang, index) => {
      const isAvailable = await ensureModelLoaded(sourceLanguage, targetLang);
      if (!isAvailable) {
        console.error('[ERROR] [promptTranslationService.js]', '語言對不可用:', { sourceLanguage, targetLang });
        hasErrors = true;
        return ''; // 失敗時返回空字串
      }

      // 每次請求都創建新工作階段
      const session = await LanguageModel.create({
        temperature: 0.2,
        topK: 1
      });
      console.debug('[DEBUG] [promptTranslationService.js]', '創建新 LanguageModel 工作階段:', { cacheKey, targetLang });

      // 建構單一語言翻譯提示
      const promptText = `Translate this text from ${sourceLanguage} to ${targetLang}: "${text}". Output the translation directly as a string.`;
      try {
        const result = await session.prompt(promptText);
        console.debug('[DEBUG] [promptTranslationService.js]', '單一語言翻譯結果:', { result, promptText, text, targetLang });
        translations[index] = result.trim() || '';
        console.info('[INFO] [promptTranslationService.js]', '單一語言翻譯完成:', { sourceLanguage, targetLang, translation: translations[index] });
      } catch (error) {
        console.error('[ERROR] [promptTranslationService.js]', '單一語言翻譯失敗:', { text, targetLang, error: error.message });
        hasErrors = true;
        translations[index] = ''; // 失敗時返回空字串
      } finally {
        // 銷毀工作階段
        session.destroy();
        console.debug('[DEBUG] [promptTranslationService.js]', '銷毀 LanguageModel 工作階段:', { cacheKey, targetLang });
      }
    });

    // 並行執行所有翻譯請求
    await Promise.all(translationPromises);
    console.debug('[DEBUG] [promptTranslationService.js]', '所有語言翻譯結果:', { text, translations });

    if (hasErrors) {
      console.warn('[WARN] [promptTranslationService.js]', '部分語言翻譯失敗，但返回可用結果:', { sourceLanguage, targetLanguages, translations });
      // 可選：如果要求全成功才返回，則在此 return null；目前允許部分成功
    } else {
      console.info('[INFO] [promptTranslationService.js]', '所有語言翻譯完成:', { sourceLanguage, targetLanguages, translations });
    }
  } catch (error) {
    console.error('[ERROR] [promptTranslationService.js]', '翻譯初始化失敗:', { sourceLanguage, targetLanguages, error: error.message });
    return null;
  }

  return { translations };
}

// 預下載語言模型（綁定到按鈕點擊）
function setupPromptModelDownload(sourceLang, targetLangs) {
  const downloadButton = document.getElementById('prompt-api-download');
  if (downloadButton) {
    downloadButton.addEventListener('click', async () => {
      if (!('LanguageModel' in self)) {
        console.debug('[DEBUG] [PromptAPI] LanguageModel API 不支援');
        return;
      }

      const sourceText = document.getElementById('status-display');
      const updateSourceText = (text) => {
        if (sourceText && text.trim().length !== 0 && sourceText.textContent !== text) {
          requestAnimationFrame(() => {
            sourceText.textContent = text;
            sourceText.dataset.stroke = text;
            sourceText.style.display = 'inline-block';
            sourceText.offsetHeight;
            sourceText.style.display = '';
          });
        }
      };

      const session = await LanguageModel.create({
        outputLanguage: 'ja', 
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            const progress = Math.round(e.loaded * 100);
            console.debug('[DEBUG] [PromptAPI] 模型下載進度:', { progress });
            updateSourceText(`語言模型下載中：${progress}%`);
          });
        }
      });
      console.info('[INFO] [PromptAPI] 語言模型下載完成。');
      updateSourceText('語言模型下載完成。');
      setTimeout(() => updateSourceText(''), 5000);
      session.destroy(); // 僅下載，不保留工作階段
    });
  }
}

export { ensureModelLoaded, setupPromptModelDownload, sendPromptTranslation };