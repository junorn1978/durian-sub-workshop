import { getPromptApiCode } from './config.js';
import { updateStatusDisplay } from './translationController.js';


// SessionManager：用於管理 LanguageModel 工作階段的池子
const sessionPool = new Map(); // key: cacheKey, val: { session, lastUsedAt, idleTimer }
const SESSION_IDLE_MS = 90_000; // 閒置 90 秒後自動銷毀
const TOKEN_REMAIN_THRESHOLD = 500; // Token 剩餘門檻

// 生成 session key：基於目標語言和選項
function makeKey(targetLang, options) {
  return `${targetLang}|t=${options.temperature}|k=${options.topK}`;
}

// 取得或建立 session
async function getSession(targetLang, options) {
  const key = makeKey(targetLang, options);
  const hit = sessionPool.get(key);
  if (hit?.session) {
    clearTimeout(hit.idleTimer);
    console.debug('[DEBUG] [promptTranslationService.js]', '重用現有 LanguageModel 工作階段:', { key });
    return hit.session;
  }
  // 建立新 session（新增：system prompt 與語言預期）
  const session = await LanguageModel.create({
    temperature: options.temperature ?? 0.1,
    topK: options.topK ?? 20,
    initialPrompts: [{  // System prompt：設定翻譯助手角色
      role: 'system',
      content: `你是專業的翻譯人員。
                翻譯規則：
                1.翻譯結果為繁體中文時，使用台灣用語。
                2.原始語言為日文時，除非人稱有在prompt中被明確指定，否則請勿生成人稱代詞。
                3.僅輸出譯文，不解釋任何翻譯過程。
                4.音樂直播用，翻譯風格以音樂和遊戲直播為主`
    }],
  });
  sessionPool.set(key, {
    session,
    lastUsedAt: Date.now(),
    idleTimer: setTimeout(() => safeDestroy(key), SESSION_IDLE_MS)
  });
  console.debug('[DEBUG] [promptTranslationService.js]', '建立新 LanguageModel 工作階段:', { key });
  return session;
}

// 標記 session 已使用，刷新閒置計時器
function markUsed(targetLang, options) {
  const key = makeKey(targetLang, options);
  const item = sessionPool.get(key);
  if (!item) return;
  clearTimeout(item.idleTimer);
  item.lastUsedAt = Date.now();
  item.idleTimer = setTimeout(() => safeDestroy(key), SESSION_IDLE_MS);
  console.debug('[DEBUG] [promptTranslationService.js]', '刷新 LanguageModel 工作階段計時器:', { key });
}

// 安全銷毀 session
function safeDestroy(key) {
  const item = sessionPool.get(key);
  if (item) {
    try {
      item.session.destroy();
      console.debug('[DEBUG] [promptTranslationService.js]', '銷毀 LanguageModel 工作階段:', { key });
    } catch (error) {
      console.debug('[DEBUG] [promptTranslationService.js]', '銷毀 LanguageModel 工作階段時發生錯誤:', { key, error: error.message });
    }
    sessionPool.delete(key);
  }
}

// 銷毀所有 session
function destroyAllSessions() {
  for (const key of sessionPool.keys()) {
    safeDestroy(key);
  }
  console.debug('[DEBUG] [promptTranslationService.js]', '銷毀所有 LanguageModel 工作階段');
}

// 檢查 Token 剩餘預算（基於官方 API 的 inputQuota 和 inputUsage）
async function ensureTokenBudget(session) {
  try {
    const remaining = session.inputQuota - session.inputUsage;
    if (remaining <= TOKEN_REMAIN_THRESHOLD) {
      console.warn('[WARN] [promptTranslationService.js]', 'Token 剩餘不足，需重建工作階段:', { remaining });
      return false;
    }
    return true;
  } catch (error) {
    // 若無法取得 quota，使用資訊，就略過檢查
    console.debug('[DEBUG] [promptTranslationService.js]', '無法檢查 Token 預算，略過:', { error: error.message });
    return true;
  }
}

// 確保語言模型已載入
async function ensureModelLoaded(sourceLanguage, targetLanguage) {
  try {
    console.debug('[DEBUG] [promptTranslationService.js]', '檢查語言模型可用性:', { sourceLanguage, targetLanguage });
    const availability = await LanguageModel.availability();
    if (availability === 'available') {
      console.info('[INFO] [promptTranslationService.js]', '語言模型已準備好:', { sourceLanguage, targetLanguage });
      return true;
    }
    if (availability !== 'downloadable') {
      console.error('[ERROR] [promptTranslationService.js]', '語言模型不可下載:', { availability });
      return false;
    }

    // 下載邏輯由外部按鈕觸發，這裡僅檢查
    await new Promise(resolve => setTimeout(resolve, 1000)); // 簡化等待，實際應監聽事件
    const newAvailability = await LanguageModel.availability();
    if (newAvailability === 'available') {
      console.info('[INFO] [promptTranslationService.js]', '語言模型下載完成:', { sourceLanguage, targetLanguage });
      return true;
    } else {
      updateStatusDisplay('言語モデルはまだ準備が整っていません。未ダウンロード、または非対応の可能性があります。');
      console.error('[ERROR] [promptTranslationService.js]', '語言模型下載失敗:', { sourceLanguage, targetLanguage });
      return false;
    }
  } catch (error) {
    console.error('[ERROR] [promptTranslationService.js]', '語言模型載入失敗:', { sourceLanguage, targetLanguage, error: error.message });
    return false;
  }
}

// 使用 Prompt API 進行翻譯
async function sendPromptTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    console.debug('[DEBUG] [promptTranslationService.js]', '無效文字，跳過翻譯:', text);
    return null;
  }

  const translations = new Array(targetLangs.length).fill('');
  const sourceLanguage = getPromptApiCode(sourceLang);
  const targetLanguages = targetLangs.map(lang => getPromptApiCode(lang));
  const options = { temperature: 0, topK: 20 }; // 固定選項
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

      let session;
      let retryCount = 0;
      const maxRetries = 1; // 最多重試一次

      while (retryCount <= maxRetries) {
        try {
          session = await getSession(targetLang, options);
          
          // 可選：檢查 Token 剩餘，不足就重建
          if (!(await ensureTokenBudget(session))) {
            const key = makeKey(targetLang, options);
            safeDestroy(key);
            session = await getSession(targetLang, options);
          }

          // 建構 user prompt 訊息陣列（修改：使用 user role，並精調為結構化指令）
          const userMessages = [{
            role: 'user',
            content: `將 ${sourceLanguage} 翻譯成 ${targetLang} :\n\n${text}\n\n`
          }];
          
          const result = await session.prompt(userMessages);  // 修改：傳入訊息陣列
          translations[index] = result.trim() || '';
          console.info('[INFO] [promptTranslationService.js]', '單一語言翻譯完成:', { sourceLanguage, targetLang, translation: translations[index] });
          
          markUsed(targetLang, options); // 標記已使用，刷新計時器
          break; // 成功，跳出重試迴圈
        } catch (error) {
          retryCount++;
          console.error('[ERROR] [promptTranslationService.js]', `單一語言翻譯失敗 (重試 ${retryCount}/${maxRetries}):`, { text, targetLang, error: error.message });
          
          if (retryCount <= maxRetries) {
            // 錯誤時重建 session 並重試
            const key = makeKey(targetLang, options);
            safeDestroy(key);
            console.debug('[DEBUG] [promptTranslationService.js]', '因錯誤重建 LanguageModel 工作階段:', { key });
          } else {
            hasErrors = true;
            translations[index] = ''; // 最終失敗，返回空字串
          }
        }
      }
    });

    // 並行執行所有翻譯請求
    await Promise.all(translationPromises);
    console.debug('[DEBUG] [promptTranslationService.js]', '所有語言翻譯結果:', { text, translations });

    if (hasErrors) {
      console.warn('[WARN] [promptTranslationService.js]', '部分語言翻譯失敗，但返回可用結果:', { sourceLanguage, targetLanguages, translations });
      // 可選：如果要求全成功才返回，則在此 return null；目前允許部分成功
    } else {
      //console.info('[INFO] [promptTranslationService.js]', '所有語言翻譯完成:', { sourceLanguage, targetLanguages, translations });
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
        console.debug('[DEBUG] [promptTranslationService.js]', 'LanguageModel API 不支援');
        updateStatusDisplay(`この機能は現在ご利用いただけません。`);
        return;
      }

      try {
        const session = await LanguageModel.create({
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const progress = Math.round(e.loaded * 100);
              console.debug('[DEBUG] [promptTranslationService.js]', '模型下載進度:', { progress });
              updateStatusDisplay(`モデルダウンロード：${progress}%`);
            });
          }
        });
        console.info('[INFO] [promptTranslationService.js]', '語言模型下載完成。');
        updateStatusDisplay('モデルダウンロードが完了しました。');
        setTimeout(() => updateStatusDisplay(''), 5000);
        session.destroy(); // 僅下載，不保留工作階段
      } catch (error) {
        console.error('[ERROR] [promptTranslationService.js]', '語言模型下載失敗:', { error: error.message });
        updateStatusDisplay('モデルダウンロードに失敗しました。');
      }
    });
  }
}

export { setupPromptModelDownload, sendPromptTranslation };