// localTranslation.js
import { getTargetCodeById } from './config.js';

// 語言代碼映射函式，將如'ja-JP'轉為'ja'
function mapLanguageCode(code) {
  return code.split('-')[0].toLowerCase();
}

// 本地翻譯主函式
async function localTranslate(text, targetLangs, sourceLang, sequenceId) {
  if (!('Translator' in self)) {
    console.debug('[DEBUG] [localTranslation] Translator API 不支援');
    throw new Error('Translator API 不支援');
  }

  // 檢查模型可用性
  const availability = await Translator.availability();
  if (availability !== 'available' && availability !== 'downloadable') {
    console.debug('[DEBUG] [localTranslation] 模型不可用:', availability);
    throw new Error('模型不可用');
  }

  let detectedSource = mapLanguageCode(sourceLang);
  if (sourceLang === 'AUTO') {
    if (!('LanguageDetector' in self)) {
      console.debug('[DEBUG] [localTranslation] LanguageDetector API 不支援');
      throw new Error('LanguageDetector API 不支援');
    }
    const detectorAvailability = await LanguageDetector.availability();
    if (detectorAvailability !== 'available' && detectorAvailability !== 'downloadable') {
      console.debug('[DEBUG] [localTranslation] 語言偵測模型不可用:', detectorAvailability);
      throw new Error('語言偵測模型不可用');
    }
    const detector = await LanguageDetector.create({
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => {
          console.debug('[DEBUG] [localTranslation] 語言偵測模型下載進度:', e.loaded * 100 + '%');
        });
      }
    });
    const results = await detector.detect(text);
    if (results.length > 0) {
      detectedSource = results[0].detectedLanguage;
      console.info('[INFO] [localTranslation] 偵測到來源語言:', detectedSource);
    } else {
      throw new Error('無法偵測語言');
    }
  }

  const translations = [];
  for (const target of targetLangs) {
    const mappedTarget = mapLanguageCode(getTargetCodeById(target));
    const translator = await Translator.create({
      sourceLanguage: detectedSource,
      targetLanguage: mappedTarget,
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => {
          console.debug('[DEBUG] [localTranslation] 翻譯模型下載進度:', e.loaded * 100 + '%');
        });
      }
    });
    const result = await translator.translate(text);
    translations.push(result);
    console.info('[INFO] [localTranslation] 翻譯完成:', { target: mappedTarget, result });
  }

  return { translations, sequenceId };
}

export { localTranslate };