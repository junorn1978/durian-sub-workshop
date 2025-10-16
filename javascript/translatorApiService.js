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
    if (!localTranslationButton?.classList.contains('active')) {
      console.debug('[DEBUG] [Translator API] local-translation-api 未啟用');
      return;
    }

    const sourceLang = document.getElementById('source-language')?.value;  // 移除預設 'ja-JP'，若無選擇則為空字串
    const targetLangs = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none').map(lang => getLanguageModelApiCode(lang));

    if (!sourceLang) {
      console.debug("[DEBUG]", "[translatorApiService.js]", "來源語言未選擇，跳過預載", { sourceLang });
      return;  // 無來源語言時直接結束，不執行後續
    }

    if (localTranslationButton.classList.contains('active') && targetLangs.length > 0) {
      console.debug("[DEBUG]", "[translatorApiService.js]", "檢測到 local-translation-api 啟用，開始預下載模型", { sourceLang, targetLangs });
      preloadTranslationModels(sourceLang, targetLangs);
    } else {
      console.debug("[DEBUG]", "[translatorApiService.js]", "local-translation-api 未啟用或無目標語言", { sourceLang, targetLangs });
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
async function sendLocalTranslation(text, targetLangs, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translator API] 無效文字，跳過翻譯:', text);
    return null;
  }

  const sourceLanguageCode = getLanguageModelApiCode(sourceLang);
  if (sourceLanguageCode === 'ja') {
    text = preprocessJapaneseText(text);
  }

  const translations = new Array(targetLangs.length).fill('');
  let allAvailable = true;

  for (let i = 0; i < targetLangs.length; i++) {
    const sourceLanguage = getLanguageModelApiCode(sourceLang);
    const targetLanguage = getLanguageModelApiCode(targetLangs[i]);
    const cacheKey = `${sourceLanguage}-${targetLanguage}`;

    try {
      const isAvailable = await ensureModelLoaded(sourceLanguage, targetLanguage);
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

// 文字翻譯前的語句標點符號加入
// 因為沒有加入表點符號的話這個 API 翻譯會很容易去中間只翻譯頭尾，所以需要加入標點符號盡可能讓他翻譯稍微好一點，但只能說能不要用這個API就不要用
function preprocessJapaneseText(text) {
  try {
    if (typeof text !== 'string' || text.trim().length < 5) {
      console.debug('[DEBUG] [Translator API] 文字過短或非字串，跳過日語前處理:', { text });
      return text;
    }

    // 常見「句末」形式（遇到這些且目前未有終止符，補「。」）
    const END_FORMS = new Set([
      'です', 'ます', 'だ', 'である', 'でした', 'だった', 'でしょう', 'だろう',
      'ですよ', 'ですね', 'ますね', 'かも', 'かな'
    ]);

    // 常見「句中」助詞（遇到這些且非最後一個 token、且未有停頓符，補「、」）
    const MID_PARTS = new Set([
      'は','が','を','に','で','と','へ','や','から','まで','も','より','しか','こそ','でも','など','ね','よ'
    ]);

    // 以空白切分（將全角/半角空白都視為分隔）
    const tokens = text.trim().split(/\s+/u);
    if (tokens.length === 1) return text; // 單一 token 不做

    let hasEndForm = false; // 追蹤是否遇到 END_FORMS

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (!tk) continue;

      // 去掉尾端既有標點後的「純詞形」（簡化版，無 HAS_PUNCT_TAIL 檢查）
      const base = tk.replace(/[。！？!?、，｡､]+$/gu, '');

      // 補句末「。」：僅在最後一個 token，或 base 屬於 END_FORMS 時
      if (i === tokens.length - 1) {
        if (END_FORMS.has(base)) {
          tokens[i] = `${base}。`;
          hasEndForm = true;
        } else {
          // 最後一個 token 不是句中助詞，且沒有任何標點時，可視需求選擇是否強制補「。」。
          // 若不想強制，可註解下一行。
          tokens[i] = `${tk}。`;
        }
        continue;
      }

      // 補句中「、」：僅在非最後一個 token 且為明確的助詞時
      if (MID_PARTS.has(base)) {
        tokens[i] = `${base}、`;
      }

      // 檢查是否為 END_FORMS（非最後 token 也可能有）
      if (END_FORMS.has(base)) {
        tokens[i] = `${base}。`;
        hasEndForm = true;
      }
    }

    let processed = tokens.join(' ');

    // 若無任何 END_FORMS 符合，則將空格改為「、」，但排除片假名和英文 token 間
    if (!hasEndForm) {
      // 判斷片假名/英文 token 的正則（片假名：カタカナ、英文：A-Z a-z）
      const isKatakanaOrEnglish = /^[\u30A0-\u30FF\uFF00-\uFFEF\uFF65-\uFF9F\uFF9E\uFF9F]+|[A-Za-z]+$/u;
      
      // 檢查相鄰 token 是否皆為片假名/英文，若是則保持空格連接，否則用「、」連接
      const newTokens = [];
      for (let j = 0; j < tokens.length; j++) {
        if (j === 0) {
          newTokens.push(tokens[j]);
          continue;
        }
        const prevToken = tokens[j - 1];
        const currToken = tokens[j];
        // 若前一個 token 為片假名/英文，且當前 token 為片假名/英文，則用空格連接
        if (isKatakanaOrEnglish.test(prevToken.replace(/[。！？!?、，｡､]+$/gu, '')) && 
            isKatakanaOrEnglish.test(currToken.replace(/[。！？!?、，｡､]+$/gu, ''))) {
          newTokens.push(' ' + currToken);
        } else {
          newTokens[newTokens.length - 1] += '、';
          newTokens.push(currToken.replace(/^[、\s]+/gu, '')); // 避免重複
        }
      }
      processed = newTokens.join('').trim();
    }

    console.debug('[DEBUG] [Translator API] 日語前處理完成:', { originalText: text, processedText: processed });
    return processed;
  } catch (error) {
    console.error('[ERROR] [Translator API] 日語前處理失敗，使用原文字:', { text, error: error.message });
    return text;
  }
}

export { monitorLocalTranslationAPI, sendLocalTranslation };