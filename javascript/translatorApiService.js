import { getTargetCodeForTranslator } from './config.js';
import { sequenceCounter, translatorCache, updateStatusDisplay, updateTranslationUI } from './translationController.js';

// 確保語言模型已載入
async function ensureModelLoaded(sourceLanguage, targetLanguage, updateSourceText) {
  try {
    console.debug('[DEBUG] [Translator API] 檢查語言模型可用性:', { sourceLanguage, targetLanguage });
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
    setTimeout(() => updateStatusDisplay(''), 5000); // 修改為 5 秒清空
    return true;
  } catch (error) {
    console.error('[ERROR] [Translator API] 語言模型下載失敗:', { sourceLanguage, targetLanguage, error: error.message });
    updateStatusDisplay('翻訳モデルを読み込めなかったため、リモートサービスを利用します。');
    setTimeout(() => updateStatusDisplay(''), 5000); // 修改為 5 秒清空
    return false;
  }
}

// 使用 Chrome Translator API 進行翻譯（加入斷句、分批與組合邏輯，針對日語）
async function sendLocalTranslation(text, targetLangs, sourceLang, updateSourceText) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translator API] 無效文字，跳過翻譯:', text);
    return null;
  }

  const translations = new Array(targetLangs.length).fill('');
  let allAvailable = true;

  for (let i = 0; i < targetLangs.length; i++) {
    const sourceLanguage = getTargetCodeForTranslator(sourceLang);
    const targetLanguage = getTargetCodeForTranslator(targetLangs[i]);
    const cacheKey = `${sourceLanguage}-${targetLanguage}`;

    try {
      const isAvailable = await ensureModelLoaded(sourceLanguage, targetLanguage, updateSourceText);
      if (!isAvailable) {
        console.error('[ERROR] [Translator API] 語言對不可用:', { sourceLanguage, targetLanguage });
        allAvailable = false;
        continue;
      }

      // 檢查快取中是否已有 Translator 物件
      let translator = translatorCache.get(cacheKey);
      if (!translator) {
        translator = await Translator.create({ sourceLanguage, targetLanguage });
        translatorCache.set(cacheKey, translator);
        console.debug('[DEBUG] [Translator API] 創建並快取 Translator:', { cacheKey });
      } else {
        console.debug('[DEBUG] [Translator API] 重用快取中的 Translator:', { cacheKey });
      }

      try {
        const result = await translator.translate(text); // 直接翻譯整段文字
        console.debug('[DEBUG] [Translator API] 翻譯結果:', { text, result });
        translations[i] = result;
        //console.info('[INFO] [Translator API] 翻譯完成:', { sourceLanguage, targetLanguage, result });
      } catch (error) {
        console.error('[ERROR] [Translator API] 翻譯失敗:', { text, error: error.message });
        updateStatusDisplay('翻訳エラー:', { error: error.message });
        setTimeout(() => updateStatusDisplay(''), 5000);
        translations[i] = ''; // 失敗時返回空字串
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

  // 在所有翻譯完成後一次性更新 UI
  if (translations.some(t => t !== '')) {
    await updateTranslationUI(
      { translations, sequenceId: sequenceCounter },
      targetLangs,
      0.5, // 使用較短顯示時間
      sequenceCounter
    );
  }

  return { translations, sequenceId: sequenceCounter };
}

// 預下載語言模型
async function preloadTranslationModels(sourceLang, targetLangs, updateSourceText) {
  if (!('Translator' in self)) {
    console.debug('[DEBUG] [Translator API] Translator API 不支援');
    updateStatusDisplay('新しい Translator API はサポートされていないため、翻訳リンクを利用します。');
    setTimeout(() => updateStatusDisplay(''), 5000);
    return;
  }

  for (const targetLang of targetLangs) {
    const sourceLanguage = getTargetCodeForTranslator(sourceLang);
    const targetLanguage = getTargetCodeForTranslator(targetLang);
    await ensureModelLoaded(sourceLanguage, targetLanguage, updateSourceText);
  }
}

export { ensureModelLoaded, preloadTranslationModels, sendLocalTranslation };