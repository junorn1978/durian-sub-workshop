// translatorApiService.js
import { getLanguageModelApiCode } from './config.js';
import { sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI } from './translationController.js';


// 監聽 local-translation-api 狀態變化
function monitorLocalTranslationAPI() {
  const localTranslationButton = document.getElementById('local-translation-api');
  if (!localTranslationButton) {
    console.debug('[DEBUG] [Translator API] 未找到 local-translation-api 元素');
    return;
  }

  const checkAndPreload = () => {
    const sourceLang = document.getElementById('source-language')?.value || 'ja-JP';
    const targetLangs = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none').map(lang => getLanguageModelApiCode(lang));

    if (localTranslationButton.classList.contains('active') && targetLangs.length > 0) {
      console.debug('[DEBUG] [Translator API] 檢測到 local-translation-api 啟用，開始預下載模型:', { sourceLang, targetLangs });
      preloadTranslationModels(sourceLang, targetLangs);
    } else {
      console.debug('[DEBUG] [Translator API] local-translation-api 未啟用或無目標語言');
    }
  };

  localTranslationButton.addEventListener('click', () => {
    setTimeout(checkAndPreload, 0);
  });

  checkAndPreload();

  ['source-language', 'target1-language', 'target2-language', 'target3-language'].forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      select.addEventListener('change', checkAndPreload);
    }
  });
}

// 確保語言模型已載入
async function ensureModelLoaded(sourceLanguage, targetLanguage) {
  try {
    //console.debug('[DEBUG] [Translator API] 檢查語言模型可用性:', { sourceLanguage, targetLanguage });
    const availability = await Translator.availability({ sourceLanguage, targetLanguage });
    if (availability === 'available') {
      console.debug('[DEBUG] [Translator API] 語言模型已準備好:', { sourceLanguage, targetLanguage });
      return true;
    }
    if (availability !== 'downloadable') {
      console.error('[ERROR] [Translator API] 語言模型不可下載:', { sourceLanguage, targetLanguage, availability });
      return false;
    }

    updateStatusDisplay(`翻訳モデル（${sourceLanguage} → ${targetLanguage}）をダウンロード中…`);
    await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const progress = Math.round(e.loaded * 100);
          console.debug('[DEBUG] [Translator API] 模型下載進度:', { sourceLanguage, targetLanguage, progress });
          updateStatusDisplay(`翻訳モデル（${sourceLanguage} → ${targetLanguage}）をダウンロード中：${progress}%`);
        });
      }
    });
    console.info('[INFO] [Translator API] 語言模型下載完成:', { sourceLanguage, targetLanguage });
    updateStatusDisplay(`翻訳モデル（${sourceLanguage} → ${targetLanguage}）のダウンロードが完了しました。`);
    setTimeout(() => updateStatusDisplay(''), 5000);
    return true;
  } catch (error) {
    console.error('[ERROR] [Translator API] 語言模型下載失敗:', { sourceLanguage, targetLanguage, error: error.message });
    updateStatusDisplay('翻訳モデルを読み込めなかったため、リモートサービスを利用します。');
    setTimeout(() => updateStatusDisplay(''), 5000);
    return false;
  }
}

// 使用 Chrome Translator API 進行翻譯（加入斷句、分批與組合邏輯，針對日語）
async function sendLocalTranslation(text, targetLangs, sourceLang) { // 移除 updateSourceText
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translator API] 無效文字，跳過翻譯:', text);
    return null;
  }

  const translations = new Array(targetLangs.length).fill('');
  let allAvailable = true;

  for (let i = 0; i < targetLangs.length; i++) {
    const sourceLanguage = getLanguageModelApiCode(sourceLang);
    const targetLanguage = getLanguageModelApiCode(targetLangs[i]);
    const cacheKey = `${sourceLanguage}-${targetLanguage}`;

    try {
      const isAvailable = await ensureModelLoaded(sourceLanguage, targetLanguage); // 已移除 updateSourceText
      if (!isAvailable) {
        console.error('[ERROR] [Translator API] 語言對不可用:', { sourceLanguage, targetLanguage });
        allAvailable = false;
        continue;
      }

      let translator = translatorCache.get(cacheKey);
      if (!translator) {
        translator = await Translator.create({ sourceLanguage, targetLanguage });
        translatorCache.set(cacheKey, translator);
        console.debug('[DEBUG] [Translator API] 創建並快取 Translator:', { cacheKey });
      } else {
        console.debug('[DEBUG] [Translator API] 重用快取中的 Translator:', { cacheKey });
      }

      try {
        const result = await translator.translate(text);
        //console.debug('[DEBUG] [Translator API] 翻譯結果:', { text, result });
        translations[i] = result;
      } catch (error) {
        console.error('[ERROR] [Translator API] 翻譯失敗:', { text, error: error.message });
        updateStatusDisplay('翻訳エラー:', { error: error.message });
        setTimeout(() => updateStatusDisplay(''), 5000);
        translations[i] = '';
      }
    } catch (error) {
      console.error('[ERROR] [Translator API] 翻譯初始化失敗:', { sourceLanguage, targetLanguage, error: error.message });
      allAvailable = false;
    }
  }

  if (!allAvailable) {
    updateStatusDisplay('翻訳は利用できません。リモートサービスを使用します。');
    setTimeout(() => updateStatusDisplay(''), 5000);
    return null;
  }

  if (translations.some(t => t !== '')) {
    await updateTranslationUI(
      { translations, sequenceId: sequenceCounter },
      targetLangs,
      0.5,
      sequenceCounter
    );
  }

  return { translations, sequenceId: sequenceCounter };
}

// 預下載語言模型
async function preloadTranslationModels(sourceLang, targetLangs) {
  if (!('Translator' in self)) {
    console.debug('[DEBUG] [Translator API] Translator API 不支援');
    updateStatusDisplay('新しい Translator API はサポートされていないため、翻訳リンクを利用します。');
    setTimeout(() => updateStatusDisplay(''), 5000);
    return;
  }

  for (const targetLang of targetLangs) {
    const sourceLanguage = getLanguageModelApiCode(sourceLang);
    const targetLanguage = getLanguageModelApiCode(targetLang);
    await ensureModelLoaded(sourceLanguage, targetLanguage);
  }
}

export { ensureModelLoaded, monitorLocalTranslationAPI, sendLocalTranslation };