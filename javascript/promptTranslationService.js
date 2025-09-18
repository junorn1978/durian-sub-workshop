// ==============
// promptTranslationService.js (優化版)
// ==============

export function isPromptApiSupported() {
  return 'LanguageModel' in self;
}

/**
 * 使用通用的 Prompt API 進行文字翻譯
 * @param {string} textToTranslate - 需要翻譯的文字
 * @param {string} targetLanguage - 目標語言 (例如 '繁體中文', 'Japanese')
 * @param {string} sourceLanguage - 來源語言 (例如 'English', '中文')
 * @returns {Promise<string>} 翻譯後的文字
 * @throws {Error} 如果 API 無法使用或執行失敗
 */
export async function translateWithPrompt(textToTranslate, targetLanguage, sourceLanguage, languageModelApiCode) {
  if (!isPromptApiSupported()) {
    throw new Error('此瀏覽器不支援內建的 Prompt API。');
  }

  // 1. **[System Prompt]**: 設定 AI 的角色和嚴格規則
  const systemPrompt = `You are an expert translation engine. Your sole task is to translate the user's text from ${sourceLanguage} to ${targetLanguage}.
  
  CRITICAL RULES:
  1. You must translate the text in its entirety. Do not summarize, shorten, or omit any part of the original text.
  2. Your output must ONLY be the translated text. Do not include any prefixes like "Here is the translation:", apologies, or any other explanatory text.
  3. Ensure the translation is accurate and fluent.`;

  // 2. **[User Prompt]**: 清晰標示出使用者提供的內容
  const userPrompt = `Translate the following text:\n---\n${textToTranslate}`;

  // 3. 組合最終的 Prompt
  const finalPrompt = `${systemPrompt}\n\n${userPrompt}`;

  try {
    const availability = await window.LanguageModel.availability();
    if (availability === 'no') {
      throw new Error('AI 模型不可用。');
    }

    const session = await window.LanguageModel.create({
      outputLanguage: 'ja', 
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const progress = Math.round(e.loaded * 100);
          console.debug('[DEBUG] [promptTranslationService.js] 模型下載進度:', { progress });
        });
      }
    });

    // 執行計時，以測試速度
    console.time("Translation Speed");
    const response = await session.prompt(finalPrompt);
    console.timeEnd("Translation Speed");

    session.destroy();
    return response;
  } catch (error) {
    console.error('[ERROR] [promptTranslationService.js] 使用 Prompt API 翻譯時發生錯誤:', { error: error.message });
    throw new Error('Prompt API 執行失敗。');
  }
}