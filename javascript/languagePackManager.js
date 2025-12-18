import { updateStatusDisplay } from './translationController.js';
import { Logger } from './logger.js';

// 檢查指定語言是否支援本地語音辨識
async function isLanguageSupportedLocally(lang) {
  
  const options = { langs: [lang], processLocally: true };
  
  try {
    const status = await SpeechRecognition.available(options);
    Logger.debug("[DEBUG]", "[languagePackManager]", "檢查語言包支援:", { lang, status });
    return {
      supported: status === 'available',
      downloadable: status === 'downloadable',
      downloading: status === 'downloading'
    };
  } catch (error) {
    Logger.error("[ERROR]", "[languagePackManager]", "檢查語言包狀態失敗:", error);
    return { supported: false, downloadable: false, downloading: false };
  }
}

// 下載指定語言的語言包
async function downloadLanguagePack(lang, updateCallback) {
  if (!navigator.onLine) {
    Logger.warn("[WARN]", "[languagePackManager]", "無網路連線，無法下載語言包:", lang);
    updateCallback('ネットワークに接続できません。接続を確認してから再試行してください。');
    return false;
  }

  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    Logger.error("[ERROR]", "[languagePackManager]", "未找到下載語言包按鍵");
    updateCallback('言語パックのダウンロードボタンが見つかりません。');
    return false;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.downloading) {
    Logger.info("[INFO]", "[languagePackManager]", "語言包正在下載:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = 'ダウンロード…'; 
    updateCallback(`「${lang}」の言語パックをダウンロードしています`);
    return false;
  }

  if (!status.downloadable) {
    Logger.warn("[WARN]", "[languagePackManager]", "語言包不可下載:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = 'ダウンロード不可';
    updateCallback(`「${lang}」の言語パックはダウンロードできません`);
    return false;
  }

  try {
    Logger.info("[INFO]", "[languagePackManager]", "開始下載語言包:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = 'ダウンロード…';
    
    const options = { langs: [lang], processLocally: true };
    const success = await SpeechRecognition.install(options);
    if (success) {
      Logger.info("[INFO]", "[languagePackManager]", `語言包 ${lang} 安裝成功`);
      downloadButton.textContent = 'ダウンロード済';
      downloadButton.disabled = true;
      updateCallback(`「${lang}」のローカル音声認識の準備が整いました。利用するにはブラウザの再起動が必要です。`);
      return true;
    } else {
      Logger.error("[ERROR]", "[languagePackManager]", `無法安裝語言包 ${lang}，可能是語言不支援或下載問題`);
      downloadButton.disabled = false;
      downloadButton.textContent = 'ダウンロード失敗';
      updateCallback(`「${lang}」の言語パックのダウンロードに失敗しました。再試行してください。`);
      return false;
    }
  } catch (error) {
    Logger.error("[ERROR]", "[languagePackManager]", "下載語言包失敗:", { error: error.message, stack: error.stack });
    downloadButton.disabled = false;
    downloadButton.textContent = 'ダウンロード失敗';
    updateCallback(`「${lang}」の言語パックのダウンロードに失敗しました。再試行してください。`);
    return false;
  }
}

// 更新下載語言包按鍵的狀態
async function updateLanguagePackButton(lang) {
  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    Logger.debug("[DEBUG]", "[languagePackManager]", "未找到下載語言包按鍵，跳過更新");
    return;
  }

  if (lang === 'zh-TW') {
    Logger.debug("[DEBUG]", "[languagePackManager]", "zh-TW目前不支援本地語音辨識，禁用按鍵");
    downloadButton.disabled = true;
    downloadButton.textContent = 'パック利用不可';
    return;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.supported) {
    downloadButton.textContent = 'ダウンロード済';
    downloadButton.disabled = true;
  } else if (status.downloadable) {
    downloadButton.disabled = false;
    downloadButton.textContent = 'ダウンロード';
  } else if (status.downloading) {
    downloadButton.disabled = true;
    downloadButton.textContent = 'ダウンロード…';
  } else {
    Logger.warn("[WARN]", "[languagePackManager]", "語言包不可用", { lang, status, apiSupport: typeof SpeechRecognition.available });
    downloadButton.disabled = true;
    downloadButton.textContent = 'パック利用不可';
  }
  Logger.debug("[DEBUG]", "[languagePackManager]", "更新語言包按鍵狀態:", { lang, status });
}

// 設置下載語言包按鍵的事件處理
async function setupLanguagePackButton(languageSelectorId, updateCallback) {
  const speechLangPack = document.getElementById('download-language-pack');
  if (!speechLangPack) {
    Logger.error("[ERROR]", "[languagePackManager]", "未找到下載語言包按鍵");
    updateCallback('言語パックのダウンロードボタンが見つかりません。');
    return;
  }

  const sourceLanguageSelect = document.getElementById(languageSelectorId);
  if (!sourceLanguageSelect) {
    Logger.error("[ERROR]", "[languagePackManager]", "未找到語言選擇器:", languageSelectorId);
    updateCallback('元の言語が見つかりません');
    return;
  }

  // 初始化按鍵狀態
  const initialLang = sourceLanguageSelect.value;
  Logger.debug("[DEBUG]", "[languagePackManager]", "初始化語言:", { initialLang, selectValue: sourceLanguageSelect.value });
  await updateLanguagePackButton(initialLang);

  // 綁定點擊事件
  speechLangPack.addEventListener('click', async () => {
    const sourceLang = sourceLanguageSelect.value;
    Logger.debug("[DEBUG]", "[languagePackManager]", "點擊時語言:", { sourceLang });
    try {
      Logger.debug("[DEBUG]", "[languagePackManager]", "開始檢查語言包狀態", { lang: sourceLang });
      const status = await isLanguageSupportedLocally(sourceLang);

      if (status.supported) {
        Logger.info("[INFO]", "[languagePackManager]", "語言包已可用，無需下載", { lang: sourceLang });
        updateCallback(`「${sourceLang}」のローカル音声認識の準備が整いました。`);
        return;
      }

      if (status.downloadable) {
        Logger.info("[INFO]", "[languagePackManager]", "語言包可下載，開始下載流程", { lang: sourceLang });
        await downloadLanguagePack(sourceLang, updateCallback);
      } else if (status.downloading) {
        Logger.debug("[DEBUG]", "[languagePackManager]", "語言包正在下載中", { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的語言包正在下載`);
      } else {
        Logger.warn("[WARN]", "[languagePackManager]", "語言包不可用", { lang: sourceLang, status });
        updateCallback(`語言 ${sourceLang} 的本地語音辨識不可用`);
      }
    } catch (error) {
      Logger.error("[ERROR]", "[languagePackManager]", "點擊下載語言包時產生錯誤", error);
      updateCallback('檢查語言包失敗，請重試');
    }
  });

  // 語言切換時更新按鍵狀態
  sourceLanguageSelect.addEventListener('change', async () => {
    const newLang = sourceLanguageSelect.value;
    Logger.debug("[DEBUG]", "[languagePackManager]", "語言選擇器變更:", { newLang });
    await updateLanguagePackButton(newLang);
    Logger.info("[INFO]", "[languagePackManager]", "語言切換後更新按鍵狀態", { lang: newLang });
  });
}

export { isLanguageSupportedLocally, downloadLanguagePack, updateLanguagePackButton, setupLanguagePackButton };