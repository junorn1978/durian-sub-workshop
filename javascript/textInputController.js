// textInputController.js
import { processTranslationUrl, sendTranslationRequest, updateStatusDisplay, ensureModelLoaded } from './translationController.js';
import { updateSourceText, pauseRecognition } from './speechCapture.js';
import { getTargetCodeForTranslator } from './config.js';

// 專門處理 translation1 的本機翻譯並更新到 translation-comm
async function handleLocalTranslationComment(text, sourceLang, targetLang) {
  if (!text || !sourceLang || !targetLang) {
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '文字を入力し、翻訳元と言語を選択してください。';
    console.info('[INFO] [TextInputController] 跳過無效輸入:', { text, sourceLang, targetLang });
    return;
  }

  try {
    const sourceLanguage = getTargetCodeForTranslator(sourceLang);
    const targetLanguage = getTargetCodeForTranslator(targetLang);
    console.debug('[DEBUG] [TextInputController] 準備本機翻譯:', { text, sourceLanguage, targetLanguage });

    // 使用 ensureModelLoaded 檢查語言模型可用性
    const isAvailable = await ensureModelLoaded(sourceLanguage, targetLanguage, updateSourceText);
    if (!isAvailable) {
      throw new Error('語言模型不可用');
    }

    // 創建翻譯器並執行翻譯
    const translator = await Translator.create({ sourceLanguage, targetLanguage });
    const result = await translator.translate(text);
    console.info('[INFO] [TextInputController] 本機翻譯完成:', { text, result, sourceLanguage, targetLanguage });

    // 更新 translation-comm
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) {
      translationComm.textContent = result;
    }

    // 釋放資源
    translator.destroy();
  } catch (error) {
    console.error('[ERROR] [TextInputController] 本機翻譯失敗:', error.message);
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '翻譯失敗';
    updateStatusDisplay('ローカル翻訳に失敗しました。モデルまたはネットワークを確認してください。');
    setTimeout(() => updateStatusDisplay(''), 5000);
  }
}

// 處理 translation1 的翻譯留言邏輯（支援本機與遠端翻譯）
async function handleTranslationComment(text, sourceLang, targetLang, serviceUrl, browserInfo, isLocalTranslationActive) {
  if (!text || !sourceLang || !targetLang) {
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '文字を入力し、翻訳元と言語を選択してください。';
    console.info('[INFO] [TextInputController] 跳過無效輸入:', { text, sourceLang, targetLang });
    return;
  }

  if (sourceLang === targetLang) {
    updateStatusDisplay('翻訳元と言語が同じため、翻訳できません。');
    setTimeout(() => updateStatusDisplay(''), 5000);
    console.info('[INFO] [TextInputController] 來源與目標語言相同，跳過翻譯:', { text, sourceLang, targetLang });
    return;
  }

  try {
    if (isLocalTranslationActive && browserInfo.browser === 'Chrome' && browserInfo.supportsTranslatorAPI) {
      console.debug('[DEBUG] [TextInputController] 使用本機翻譯模組', { text, sourceLang, targetLang });
      await handleLocalTranslationComment(text, sourceLang, targetLang);
    } else {
      console.debug('[DEBUG] [TextInputController] 使用遠端翻譯服務', { text, sourceLang, targetLang, serviceUrl });
      const data = await processTranslationUrl(text, [targetLang], sourceLang, serviceUrl, '', 99999);
      if (data?.translations?.[0]) {
        const translationComm = document.getElementById('translation-comm');
        if (translationComm) {
          const result = data.translations[0];
          translationComm.textContent = result;
          console.info('[INFO] [TextInputController] translation1 遠端翻譯完成:', { text, result, sourceLang, targetLang, sequenceId: 99999 });
        }
      } else {
        throw new Error('無有效翻譯結果');
      }
    }
  } catch (error) {
    console.error('[ERROR] [TextInputController] translation1 翻譯失敗:', error.message);
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '翻譯失敗';
    updateStatusDisplay('翻訳に失敗しました。サービスへの接続またはローカルモデルを確認してください。');
    setTimeout(() => updateStatusDisplay(''), 5000);
  }
}

// 處理 translation2 的翻譯留言邏輯
async function handleTranslationCommentWithSourceUpdate(text, sourceLang, isLocalTranslationActive, browserInfo) {
  if (!text) {
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '文字を入力してください。';
    console.info('[INFO] [TextInputController] 跳過無效輸入:', { text, sourceLang });
    return;
  }

  // 暫停語音辨識 10 秒
  pauseRecognition(10000);

  try {
    // 直接更新 source-text，不應用 raymode 過濾
    updateSourceText(text);
    console.debug('[DEBUG] [TextInputController] 更新 source-text:', text);

    // 模擬語音辨識結果，觸發翻譯
    await sendTranslationRequest(text, sourceLang, browserInfo, isLocalTranslationActive);
    console.info('[INFO] [TextInputController] translation2 翻譯請求發送:', { text, sourceLang });
  } catch (error) {
    console.error('[ERROR] [TextInputController] translation2 翻譯失敗:', error.message);
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '翻訳失敗';
  }
}

// 使用 Chrome 的新 API 時，文字翻譯從這裡取得來源語系
async function detectLanguageWithAPI(text) {
  if (!text || text.trim().length === 0) {
    console.debug('[DEBUG] [TextInputController] 無文字，無法檢測語言', { text });
    return null;
  }

  try {
    const availability = await LanguageDetector.availability({ expectedInputLanguages: ['zh-Hant', 'zh', 'en', 'ja'] });
    console.debug('[DEBUG] [TextInputController] 語言檢測模型可用性', { availability });

    if (availability === 'unavailable') {
      console.error('[ERROR] [TextInputController] 語言檢測模型不可用');
      return null;
    }

    const detector = await LanguageDetector.create({
      expectedInputLanguages: ['zh-Hant', 'zh', 'en', 'ja'],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          console.debug('[DEBUG] [TextInputController] 語言檢測模型下載進度', { progress: Math.floor(e.loaded * 100) });
        });
      }
    });

    const results = await detector.detect(text);
    console.debug('[DEBUG] [TextInputController] 語言檢測結果', { results });

    if (!results || results.length === 0 || !results[0].detectedLanguage) {
      console.error('[ERROR] [TextInputController] 語言檢測無有效結果', { results });
      return null;
    }

    const detectedLanguage = results[0].detectedLanguage;
    console.info('[INFO] [TextInputController] 語言檢測完成', { text, detectedLanguage, confidence: results[0].confidence });
    detector.destroy();
    return detectedLanguage;
  } catch (error) {
    console.error('[ERROR] [TextInputController] 語言檢測失敗', { error: error.message });
    return null;
  }
}

// 初始化文字輸入相關的事件綁定
function setupTextInputTranslation() {
  const translationButton = document.getElementById('translation1');
  const translation2Button = document.getElementById('translation2');
  const commentInput = document.getElementById('comment-input');

  if (translationButton && commentInput) {
    translationButton.addEventListener('click', async () => {
      const text = commentInput.value.trim();
      const isLocalActive = document.getElementById('local-translation-api')?.classList.contains('active') || false;
      const browserInfo = {
        browser: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
        supportsTranslatorAPI: 'Translator' in self
      };
      const sourceLang = isLocalActive && browserInfo.browser === 'Chrome' 
        ? await detectLanguageWithAPI(text) || 'AUTO'
        : 'AUTO';
      const targetLang = document.querySelector('input[name="comment-lang"]:checked')?.value;
      const serviceUrl = document.getElementById('translation-link')?.value;

      await handleTranslationComment(text, sourceLang, targetLang, serviceUrl, browserInfo, isLocalActive);
    });
  }

  if (translation2Button && commentInput) {
    translation2Button.addEventListener('click', async () => {
      const text = commentInput.value.trim();
      const sourceLang = document.getElementById('source-language')?.value || 'AUTO';
      const isLocalTranslationActive = document.getElementById('local-translation-api')?.classList.contains('active') || false;
      const browserInfo = {
        browser: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
        supportsTranslatorAPI: 'Translator' in self
      };
      await handleTranslationCommentWithSourceUpdate(text, sourceLang, isLocalTranslationActive, browserInfo);
    });
  }
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', () => {
  setupTextInputTranslation();
  console.debug('[DEBUG] [TextInputController] 文字輸入翻譯功能已初始化');
});

export { setupTextInputTranslation, handleTranslationComment, handleTranslationCommentWithSourceUpdate, handleLocalTranslationComment };