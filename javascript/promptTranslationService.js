//promptTranslationService.js
import { getPromptApiCode, isPromptApiActive } from './config.js';
import { updateStatusDisplay } from './translationController.js';


// SessionManager：用於管理 LanguageModel 工作階段的池子
const sessionPool = new Map(); // key: cacheKey, val: { session, lastUsedAt, idleTimer }
const SESSION_IDLE_MS = 90_000; // 閒置 90 秒後自動銷毀
const TOKEN_REMAIN_THRESHOLD = 5000; // Token 剩餘門檻

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
    //console.debug('[DEBUG] [promptTranslationService]', '重用現有 LanguageModel 工作階段:', { key });
    return hit.session;
  }
  // 建立新 session（新增：system prompt 與語言預期）
  const session = await LanguageModel.create({
    temperature: options.temperature ?? 0.1,
    topK: options.topK ?? 20,
    initialPrompts: [{  // System prompt：設定翻譯助手角色
      role: 'system',
      content: 'Translate the user text faithfully. Output only the translation.'
      /*
      content: `你是專業的翻譯人員。
                翻譯規則：
                1.翻譯結果為繁體中文時，使用台灣用語。
                2.原始語言為日文時，除非人稱有被明確指定，否則請勿生成人稱代詞。
                3.僅輸出譯文，不解釋任何翻譯過程，也不生成任何表情符號。
                4.音樂直播用，翻譯風格以音樂和遊戲直播為主
                範例：
                輸入：日文 "こんにちは、世界！" 到英文
                輸出：Hello, world!
                輸入：日文 "このゲームは楽しいです" 到繁體中文
                輸出：這遊戲超好玩的！`
      */
    }],
  });
  sessionPool.set(key, {
    session,
    lastUsedAt: Date.now(),
    idleTimer: setTimeout(() => safeDestroy(key), SESSION_IDLE_MS)
  });
  console.debug('[DEBUG] [promptTranslationService]', '建立新 LanguageModel 工作階段:', { key });
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
  //console.debug('[DEBUG] [promptTranslationService]', '刷新 LanguageModel 工作階段計時器:', { key });
}

// 安全銷毀 session
function safeDestroy(key) {
  const item = sessionPool.get(key);
  if (item) {
    try {
      item.session.destroy();
      console.debug('[DEBUG] [promptTranslationService]', '銷毀 LanguageModel 工作階段:', { key });
    } catch (error) {
      console.debug('[DEBUG] [promptTranslationService]', '銷毀 LanguageModel 工作階段時發生錯誤:', { key, error: error.message });
    }
    sessionPool.delete(key);
  }
}

// 檢查 Token 剩餘預算（基於官方 API 的 inputQuota 和 inputUsage）
async function ensureTokenBudget(session) {
  try {
    const remaining = session.inputQuota - session.inputUsage;
    if (remaining <= TOKEN_REMAIN_THRESHOLD) {
      console.warn('[WARN] [promptTranslationService]', 'Token 剩餘不足，需重建工作階段:', { remaining });
      return false;
    }
    return true;
  } catch (error) {
    // 若無法取得 quota，使用資訊，就略過檢查
    console.debug('[DEBUG] [promptTranslationService]', '無法檢查 Token 預算，略過:', { error: error.message });
    return true;
  }
}

// 確保語言模型已載入
async function ensureModelLoaded() {
  try {
    const availability = await LanguageModel.availability();

    if (availability === 'available') {
      console.info('[INFO] [promptTranslationService]', '語言模型已準備好:');
      return 'available';
    }

    if (availability === 'downloadable') {
      console.info('[INFO] [promptTranslationService]', '語言模型可下載');
      updateStatusDisplay('AIモデルダウンロード可能');
      return 'downloadable';
    }

    console.warn('[WARN] [promptTranslationService]', '語言模型不可用:', { availability });
    return 'unavailable';

  } catch (error) {
    console.error('[ERROR] [promptTranslationService]', '語言模型載入失敗:', { error: error.message });
    return 'error';
  }
}

// 使用 Prompt API 進行翻譯
async function sendPromptTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    console.debug('[DEBUG] [promptTranslationService]', '無效文字，跳過翻譯:', text);
    return null;
  }

  const Available = await ensureModelLoaded();
  if (Available !== 'available') {
    console.error('[ERROR] [promptTranslationService]', '語言對不可用:', { sourceLanguage, targetLang });
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

          // 建構 user prompt 訊息陣列（修改：移除 schema 描述文本，僅保留翻譯指令）
          const userMessages = [{
            role: 'user',
            //content: `將 ${sourceLanguage} 翻譯成 ${targetLang} :\n\n${text}`
            content: `Source: ${sourceLanguage} -> Target: ${targetLang}\nText: ${text}`
          }];
          
          // 修改：定義 JSON Schema 物件，並使用 responseConstraint 與 omitResponseConstraintInput
          const schema = {
            type: 'object',
            properties: {
              translation: { type: 'string' }
            },
            required: ['translation'],
            additionalProperties: false
          };
          
          const result = await session.prompt(userMessages, { 
            responseConstraint: schema,
          });
          
          // 修改：解析 JSON 結果，提取 translation 欄位並基本驗證 schema
          let parsedTranslation;
          try {
            const jsonResult = JSON.parse(result.trim());
            if (typeof jsonResult.translation === 'string' && Object.keys(jsonResult).length === 1) {
              parsedTranslation = jsonResult.translation;
              console.debug('[DEBUG] [promptTranslationService]', 'JSON schema 驗證成功', { targetLang, parsedTranslation });
            } else {
              throw new Error('Schema 不符：缺少 translation 或有額外屬性');
            }
          } catch (parseError) {
            console.debug('[DEBUG] [promptTranslationService]', 'JSON 解析或 schema 驗證失敗，回退空譯文', { targetLang, error: parseError.message, rawResult: result.trim() });
            parsedTranslation = '';
          }
          
          translations[index] = parsedTranslation;
          console.info('[INFO] [promptTranslationService]', '單一語言翻譯完成:', { sourceLanguage, targetLang, translation: translations[index] });
          
          markUsed(targetLang, options); // 標記已使用，刷新計時器
          break; // 成功，跳出重試迴圈
        } catch (error) {
          if (error.message === 'The request was cancelled.') {
            console.warn('[WARN] [promptTranslationService]', '翻譯請求被取消:', { text, targetLang });
            translations[index] = '';
            break; // 不重試，直接跳出
          }

          retryCount++;
          console.error('[ERROR] [promptTranslationService]', `單一語言翻譯失敗 (重試 ${retryCount}/${maxRetries}):`, { text, targetLang, error: error.message });
          
          if (retryCount <= maxRetries) {
            // 錯誤時重建 session 並重試
            const key = makeKey(targetLang, options);
            safeDestroy(key);
            console.debug('[DEBUG] [promptTranslationService]', '因錯誤重建 LanguageModel 工作階段:', { key });
          } else {
            hasErrors = true;
            translations[index] = ''; // 最終失敗，返回空字串
          }
        }
      }
    });

    // 並行執行所有翻譯請求
    await Promise.all(translationPromises);
    console.debug('[DEBUG] [promptTranslationService]', '所有語言翻譯結果:', { text, translations });

    if (hasErrors) {
      console.warn('[WARN] [promptTranslationService]', '部分語言翻譯失敗，但返回可用結果:', { sourceLanguage, targetLanguages, translations });
      // 可選：如果要求全成功才返回，則在此 return null；目前允許部分成功
    } else {
      //console.info('[INFO] [promptTranslationService]', '所有語言翻譯完成:', { sourceLanguage, targetLanguages, translations });
    }
  } catch (error) {
    console.error('[ERROR] [promptTranslationService]', '翻譯初始化失敗:', { sourceLanguage, targetLanguages, error: error.message });
    return null;
  }

  return { translations };
}

// 預下載語言模型（綁定到按鈕點擊）
async function setupPromptModelDownload() {
  
  if (!isPromptApiActive()) {
    console.debug('[DEBUG] [promptTranslationService]', 'Prompt API 功能未啟用，跳過模型下載按鍵設定');
    return;
  }

  const downloadButton = document.getElementById('prompt-api-download');
  if (downloadButton) {

    const STATUS_UI = {
      downloadable: { showButton: true,  msg: '　ブラウザのAIモデルをダウンロードできます' },
      available:    { showButton: false, msg: '　ブラウザのAI翻訳モデルが利用可能です' },
      downloading:  { showButton: false, msg: '　ブラウザAIモデルダウンロード中、しばらくお待ちください...' },
      unavailable:  { showButton: false, msg: '　ブラウザAIモデルはこの環境では利用できません' },
      //error:        { showButton: false, msg: 'AIモデルの状態取得に失敗しました' },
    };

    const status = await ensureModelLoaded();
    const conf = STATUS_UI[status];

    if (conf) {
      downloadButton.style.display = conf.showButton ? 'inline-block' : 'none';
      updateStatusDisplay(conf.msg);
      if (status === 'unavailable') {
        promptApiButtonStatus.disabled = true;
        promptApiButtonStatus.classList.remove('active');
        setTimeout(() => updateStatusDisplay(''), 5000);
        return;
      }
      setTimeout(() => updateStatusDisplay(''), 5000);
    }

    // 新增：若模型可用，取得目前選擇的三個語言並預先建立對應 session 以避免首次請求延遲
    if (status === 'available') {
      try {
        const targetLangElements = ['target1-language', 'target2-language', 'target3-language'].map(id => document.getElementById(id));
        const currentTargetLangs = targetLangElements
          .map(element => element?.value)
          .filter(lang => lang && lang !== 'none');
        const options = { temperature: 0, topK: 20 };
        
        // 並行預先建立每個有效語言的 session
        const initPromises = currentTargetLangs.map(targetLang => {
          const targetLangCode = getPromptApiCode(targetLang);
          return getSession(targetLangCode, options);
        });
        
        await Promise.all(initPromises);
        console.info('[INFO] [promptTranslationService]', '預先初始化 LanguageModel 工作階段成功', { currentTargetLangs });
      } catch (error) {
        console.debug('[DEBUG] [promptTranslationService]', '預先初始化 LanguageModel 工作階段失敗', { error: error.message });
      }
    }

    downloadButton.addEventListener('click', async () => {
      if (!('LanguageModel' in self)) {
        console.debug('[DEBUG] [promptTranslationService]', 'LanguageModel API 不支援');
        updateStatusDisplay(`この機能は、現在ブラウザがまだ対応していないため、ご利用いただけません。`);
        setTimeout(() => updateStatusDisplay(''), 5000);
        return;
      }

      try {
        const session = await LanguageModel.create({
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const progress = Math.round(e.loaded * 100);
              console.debug('[DEBUG] [promptTranslationService]', '模型下載進度:', { progress });
              if (progress >= 90) {
                updateStatusDisplay(`モデルダウンロード：${progress}%、90％以降は完了までに少し時間がかかります。しばらくお待ちください...`);
              } else {
                updateStatusDisplay(`モデルダウンロード：${progress}%、しばらくお待ちください...`);
              }
            });
          }
        });
        console.info('[INFO] [promptTranslationService]', '語言模型下載完成。');
        updateStatusDisplay('モデルダウンロードが完了しました。');
        setTimeout(() => updateStatusDisplay(''), 5000);
        session.destroy(); // 僅下載，不保留工作階段
      } catch (error) {
        console.error('[ERROR] [promptTranslationService]', '語言模型下載失敗:', { error: error.message });
        updateStatusDisplay('モデルダウンロードに失敗しました。');
      }
    });
  }
}

// 測試效能用的函式，使用方式: 將底下window兩行註解取消之後使用console輸入
// await benchmark(() => sendPromptTranslation('こんにちは、お久しぶり！', ['繁體中文', 'English'], '日本語'), 3);
// 之後等結果就知道了
async function benchmark(fn, rounds = 5) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();  // 執行翻譯函式
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(times.length * 0.95)] || Math.max(...times);
  console.debug('[DEBUG] [promptTranslationService]', '基準測試結果:', { avgMs: avg.toFixed(0), p95Ms: p95.toFixed(0), samples: times.map(x => x.toFixed(0)) });
  return { avgMs: avg.toFixed(0), p95Ms: p95.toFixed(0), samples: times.map(x => x.toFixed(0)) };
}

//window.sendPromptTranslation = sendPromptTranslation;
//window.benchmark = benchmark;

export { setupPromptModelDownload, sendPromptTranslation };