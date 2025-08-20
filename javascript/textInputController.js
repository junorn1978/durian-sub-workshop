// textInputController.js
import { processTranslationUrl, sendTranslationRequest } from './translationController.js';
import { updateSourceText } from './speechCapture.js';

// 處理 translation1 的翻譯留言邏輯
async function handleTranslationComment(text, sourceLang, serviceUrl) {
  if (!text || !sourceLang) {
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '請輸入文字並選擇語言';
    console.info('[INFO] [TextInputController] 跳過無效輸入:', { text, sourceLang });
    return;
  }

  try {
    const data = await processTranslationUrl(text, [sourceLang], 'AUTO', serviceUrl, '');
    if (data?.translations?.[0]) {
      const translationComm = document.getElementById('translation-comm');
      if (translationComm) {
        const result = data.translations[0];
        translationComm.textContent = result;
        translationComm.dataset.stroke = result;
        console.info('[INFO] [TextInputController] translation1 翻譯完成:', { text, result });
      }
    }
  } catch (error) {
    console.error('[ERROR] [TextInputController] translation1 翻譯失敗:', error.message);
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '翻譯失敗';
  }
}

// 處理 translation2 的翻譯留言邏輯
async function handleTranslationCommentWithSourceUpdate(text, sourceLang, isLocalTranslationActive, browserInfo) {
  if (!text || !sourceLang) {
    const translationComm = document.getElementById('translation-comm');
    if (translationComm) translationComm.textContent = '請輸入文字並選擇語言';
    console.info('[INFO] [TextInputController] 跳過無效輸入:', { text, sourceLang });
    return;
  }

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
    if (translationComm) translationComm.textContent = '翻譯失敗';
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
      const sourceLang = document.querySelector('input[name="comment-lang"]:checked')?.value;
      const serviceUrl = document.getElementById('translation-link')?.value;
      await handleTranslationComment(text, sourceLang, serviceUrl);
    });
  }

  if (translation2Button && commentInput) {
    translation2Button.addEventListener('click', async () => {
      const text = commentInput.value.trim();
      const sourceLang = document.querySelector('input[name="comment-lang"]:checked')?.value;
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

export { setupTextInputTranslation, handleTranslationComment, handleTranslationCommentWithSourceUpdate };