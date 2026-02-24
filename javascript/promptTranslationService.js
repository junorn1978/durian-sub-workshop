/**
 * @file promptTranslationService.js
 * @description 瀏覽器內建 AI (Gemini Nano/3.0) 翻譯服務。
 * 目前還處在實驗性質，等Chrome 145+以後才會繼續維護，目前停用
 */

import { getLang } from './config.js'; // [修改] 引入 getLang
import { Logger } from './logger.js';

// #region [配置與工作階段管理]

const sessionPool = new Map();
const SESSION_IDLE_MS = 90_000;
const TOKEN_REMAIN_THRESHOLD = 5000;

/**
 * 生成工作階段索引鍵
 * @param {string} promptCode - 目標語言 AI 稱呼 (如 '繁體中文')
 */
function makeKey(promptCode, options) {
  return `${promptCode}|t=${options.temperature}|k=${options.topK}`;
}

/**
 * 取得或建立 AI 工作階段
 * @async
 */
async function getSession(promptCode, options) {
  const key = makeKey(promptCode, options);
  const hit = sessionPool.get(key);
  
  if (hit?.session) {
    clearTimeout(hit.idleTimer);
    return hit.session;
  }

  const session = await LanguageModel.create({
    expectedInputs:  [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    temperature: options.temperature ?? 0.1,
    topK: options.topK ?? 20,
    initialPrompts: [{
      role: 'system',
      content: 'Translate the user text faithfully. Output only the translation.'
    }],
  });

  sessionPool.set(key, {
    session,
    lastUsedAt: Date.now(),
    idleTimer: setTimeout(() => safeDestroy(key), SESSION_IDLE_MS)
  });

  Logger.debug('[DEBUG] [promptTranslationService]', '建立新 LanguageModel 工作階段:', { key });
  return session;
}

function markUsed(promptCode, options) {
  const key = makeKey(promptCode, options);
  const item = sessionPool.get(key);
  if (!item) return;
  clearTimeout(item.idleTimer);
  item.lastUsedAt = Date.now();
  item.idleTimer = setTimeout(() => safeDestroy(key), SESSION_IDLE_MS);
}

function safeDestroy(key) {
  const item = sessionPool.get(key);
  if (item) {
    try {
      item.session.destroy();
      Logger.debug('[DEBUG] [promptTranslationService]', '銷毀 LanguageModel 工作階段:', { key });
    } catch (error) {
      Logger.debug('[DEBUG] [promptTranslationService]', '銷毀錯誤:', { key, error: error.message });
    }
    sessionPool.delete(key);
  }
}

async function ensureTokenBudget(session) {
  try {
    const remaining = session.inputQuota - session.inputUsage;
    if (remaining <= TOKEN_REMAIN_THRESHOLD) {
      Logger.warn('[WARN] [promptTranslationService]', 'Token 剩餘不足:', { remaining });
      return false;
    }
    return true;
  } catch (error) {
    return true;
  }
}
// #endregion

// #region [模型準備度檢查]

async function ensureModelLoaded() {
  try {
    const availability = await LanguageModel.availability({
      expectedInputs:  [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
    if (availability === 'available') return 'available';
    if (availability === 'downloadable') return 'downloadable';
    return 'unavailable';
  } catch (error) {
    Logger.error('[ERROR] [promptTranslationService]', '模型載入失敗:', { error: error.message });
    return 'error';
  }
}
// #endregion

// #region [翻譯執行中心]

/**
 * 使用 Prompt API (Gemini Nano) 進行翻譯
 * @async
 * @param {string} text - 原始文字
 * @param {string[]} targetLangIds - 目標語言 ID 列表
 * @param {string} sourceLangId - 來源語言 ID
 */
export async function sendPromptTranslation(text, targetLangIds, sourceLangId) {
  if (!text || text.trim() === '' || text.trim() === 'っ') return null;

  const Available = await ensureModelLoaded();
  if (Available !== 'available') return null;

  // [修改] 獲取來源語系物件
  const sourceLangObj = getLang(sourceLangId);
  if (!sourceLangObj) return null;

  const translations = new Array(targetLangIds.length).fill('');
  const options = { temperature: 0, topK: 20 };

  try {
    const translationPromises = targetLangIds.map(async (langId, index) => {
      // [修改] 獲取目標語系物件
      const targetLangObj = getLang(langId);
      if (!targetLangObj) { Logger.error("找不到目標語系物件"); return; }

      const targetPromptCode = targetLangObj.promptApiCode;
      let session;
      let retryCount = 0;
      const maxRetries = 1;

      while (retryCount <= maxRetries) {
        try {
          session = await getSession(targetPromptCode, options);

          if (!(await ensureTokenBudget(session))) {
            const key = makeKey(targetPromptCode, options);
            safeDestroy(key);
            session = await getSession(targetPromptCode, options);
          }

          const userMessages = [{
            role: 'user',
            content: `Source: ${sourceLangObj.promptApiCode} -> Target: ${targetPromptCode}\nText: ${text}`
          }];
          
          const schema = {
            type: 'object',
            properties: { translation: { type: 'string' } },
            required: ['translation'],
            additionalProperties: false
          };
          
          const result = await session.prompt(userMessages, { responseConstraint: schema });
          
          try {
            const jsonResult = JSON.parse(result.trim());
            translations[index] = jsonResult.translation || '';
          } catch (parseError) {
            translations[index] = '';
          }
          
          markUsed(targetPromptCode, options);
          break; 
        } catch (error) {
          if (error.message === 'The request was cancelled.') break;
          retryCount++;
          if (retryCount <= maxRetries) {
            safeDestroy(makeKey(targetPromptCode, options));
          }
        }
      }
    });

    await Promise.all(translationPromises);
    return { translations };
  } catch (error) {
    Logger.error('[ERROR] [promptTranslationService]', '翻譯失敗:', { error: error.message });
    return null;
  }
}
// #endregion

// #region [初始化與預載邏輯]

export async function setupPromptModelDownload() {

  const downloadButton = document.getElementById('prompt-api-download');
  if (!downloadButton) return;

  const status = await ensureModelLoaded();
  
  if (status === 'available') {
    try {
      const currentTargetLangIds = ['target1-language', 'target2-language', 'target3-language']
        .map(id => document.getElementById(id)?.value)
        .filter(id => id && id !== 'none');
      
      const initPromises = currentTargetLangIds.map(id => {
        const langObj = getLang(id);
        return langObj ? getSession(langObj.promptApiCode, { temperature: 0, topK: 20 }) : null;
      });
      await Promise.all(initPromises.filter(p => p !== null));
    } catch (error) {
      Logger.debug('[DEBUG] [promptTranslationService]', '預初始化失敗');
    }
  }
}
// #endregion