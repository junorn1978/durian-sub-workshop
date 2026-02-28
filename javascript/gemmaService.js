/**
 * @file gemmaService.js
 * @description 專門負責與本地 Gemma Server (Port 8080) 溝通的中介服務。
 * 此模組負責將前端的翻譯請求轉發至本地運行的後端 API，支援單一或多目標語言的平行請求。
 */
import { isDebugEnabled } from './logger.js';
import { getLang } from './config.js';

const GEMMA_API_URL = 'http://localhost:8080/translate';

/**
 * 發送單一翻譯請求至 Gemma 後端
 * 
 * @async
 * @param {string} text - 原始待翻譯文字
 * @param {string} targetLang - 目標語言 ID (例如: 'zh-TW')
 * @param {string} sourceLang - 來源語言 ID (例如: 'ja-JP')
 * @param {string|null} previousText - 上下文脈絡 (上一句翻譯結果或原文)
 * @returns {Promise<string|null>} 翻譯後的字串，若請求失敗或無結果則回傳 null
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
    if (isDebugEnabled()) console.error('[GemmaService] Request failed:', error.message);
    return null;
  }
}

/**
 * 批次處理多語言翻譯請求
 * 
 * 針對傳入的多個目標語言 ID，平行發送請求至本地 Gemma 服務以提升效率。
 * 
 * @async
 * @param {string} text - 來源文字
 * @param {string[]} targetLangIds - 目標語言 ID 列表 (對應 UI 上的 target1, target2, target3)
 * @param {string} sourceLangId - 來源語言 ID
 * @param {string|null} [previousText=null] - 上下文脈絡
 * @returns {Promise<{translations: Array<string|null>, sequenceId: null}>} 符合 Controller 格式的物件
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
    if (isDebugEnabled()) console.error('[GemmaService] Batch translation error:', error);
    return { translations: [] };
  }
}