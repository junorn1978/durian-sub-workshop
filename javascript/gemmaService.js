/**
 * @file gemmaService.js
 * @description 專門負責與本地 Gemma Server (Port 8080) 溝通的中介服務。
 */
import { Logger } from './logger.js';
import { getLang } from './config.js';

const GEMMA_API_URL = 'http://localhost:8080/translate';

/**
 * 發送單一翻譯請求
 * @param {string} text - 原始文字
 * @param {string} targetLang - 目標語言代碼 (e.g., 'zh-TW')
 * @returns {Promise<string|null>} 翻譯結果或 null
 */
async function translateOne(text, targetLang, sourceLang, previousText) {
  try {
    const sourceLangObj = getLang(sourceLang);
    const targetLangObj = getLang(targetLang);

    const response = await fetch(GEMMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        sourceLang: sourceLangObj.promptApiCode,
        previousText: previousText,
        targetLangs: [targetLangObj.promptApiCode] // 後端預期的是陣列
      })
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    const data = await response.json();
    // 根據後端回傳格式 { translations: ["..."], sequenceId: ... }
    return data.translations && data.translations[0] ? data.translations[0] : null;

  } catch (error) {
    Logger.error('[GemmaService] Request failed:', error.message);
    return null;
  }
}

/**
 * 批次處理多語言翻譯
 * @param {string} text - 來源文字
 * @param {Array<string>} targetLangIds - 目標語言 ID 列表 (對應 target1, target2, target3)
 * @returns {Promise<Object>} 符合 Controller 格式的物件 { translations: [], sequenceId: null }
 */
export async function translateWithGemma(text, targetLangIds, sourceLangId, previousText = null) {
  if (!targetLangIds || targetLangIds.length === 0) {
    return { translations: [] };
  }

  // 平行發送請求以爭取效率
  // 注意：雖然 GPU 是序列運算，但 HTTP 層並發可以減少 TCP 握手等待
  const promises = targetLangIds.map(langId => {
    if (!langId || langId === 'none') return Promise.resolve(null);
    return translateOne(text, langId, sourceLangId, previousText);
  });

  try {
    const results = await Promise.all(promises);
    
    // 檢查是否全失敗（代表伺服器可能沒開）
    const allFailed = results.every(r => r === null);
    if (allFailed && targetLangIds.some(id => id !== 'none')) {
      console.warn('[WRAM] [Gemma] 全部請求都失敗，有開啟gemma後端嗎?');
    }

    return {
      translations: results, // 陣列順序會與 targetLangIds 一致，這正是 UI 需要的
      sequenceId: null // 讓 Controller 自己填補
    };

  } catch (error) {
    Logger.error('[GemmaService] Batch translation error:', error);
    return { translations: [] };
  }
}