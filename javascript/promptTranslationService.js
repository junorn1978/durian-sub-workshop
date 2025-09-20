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
    console.debug('[DEBUG] [PromptAPI] 無效文字，跳過翻譯:', text);
    return null;
  }

  const translations = new Array(targetLangs.length).fill('');
  let allAvailable = true;

  // 為所有目標語言建立單一提示，要求 JSON 輸出
  const sourceLanguage = getPromptApiCode(sourceLang);
  const targetLanguages = targetLangs.map(lang => getPromptApiCode(lang));
  const cacheKey = `${sourceLanguage}-${targetLanguages.join('-')}`;

  try {
    // 檢查模型可用性（以第一個語言為代表）
    const isAvailable = await ensureModelLoaded(sourceLanguage, targetLanguages[0]);
    if (!isAvailable) {
      console.error('[ERROR] [PromptAPI] 語言對不可用:', { sourceLanguage, targetLanguages });
      allAvailable = false;
    } else {
      // 每次請求都創建新工作階段
      const session = await LanguageModel.create({
        temperature: 0.2,
        topK: 1
      });
      console.debug('[DEBUG] [PromptAPI] 創建新 LanguageModel 工作階段:', { cacheKey });

      // 建構提示，要求多語言翻譯並以 JSON 輸出
      const promptText = `Translate this text from ${sourceLanguage} to ${targetLanguages.join(', ')}: "${text}". Output as JSON: {${targetLanguages.map(lang => `"${lang}": ""`).join(', ')}}`;
      const schema = {
        type: 'object',
        properties: targetLanguages.reduce((acc, lang) => {
          acc[lang] = { type: 'string' };
          return acc;
        }, {}),
        required: targetLanguages
      };

      try {
        const result = await session.prompt(promptText, { responseConstraint: schema });
        console.info('[DEBUG] [PromptAPI] session.prompt 原始結果:', { result, promptText, text });
        const parsedResult = JSON.parse(result);
        targetLanguages.forEach((lang, index) => {
          translations[index] = parsedResult[lang] || '';
        });
        console.debug('[DEBUG] [PromptAPI] 翻譯結果:', { text, translations });
        console.info('[INFO] [PromptAPI] 翻譯完成:', { sourceLanguage, targetLanguages, translations });
      } catch (error) {
        console.error('[ERROR] [PromptAPI] 翻譯失敗:', { text, error: error.message });
        allAvailable = false;
      } finally {
        // 銷毀工作階段
        session.destroy();
        console.debug('[DEBUG] [PromptAPI] 銷毀 LanguageModel 工作階段:', { cacheKey });
      }
    }
  } catch (error) {
    console.error('[ERROR] [PromptAPI] 翻譯初始化失敗:', { sourceLanguage, targetLanguages, error: error.message });
    allAvailable = false;
  }

  if (!allAvailable) {
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