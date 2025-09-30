// 檢查指定語言是否支援本地語音辨識
async function isLanguageSupportedLocally(lang) {
  const options = { langs: [lang], processLocally: true };
  try {
    const status = await SpeechRecognition.available(options);
    console.debug("[DEBUG]", "[languagePackManager.js]", "檢查語言包支援:", { lang, status });
    return {
      supported: status === 'available',
      downloadable: status === 'downloadable',
      downloading: status === 'downloading'
    };
  } catch (error) {
    console.error("[ERROR]", "[languagePackManager.js]", "檢查語言包狀態失敗:", error);
    return { supported: false, downloadable: false, downloading: false };
  }
}

// 下載指定語言的語言包
async function downloadLanguagePack(lang, updateCallback) {
  if (!navigator.onLine) {
    console.warn("[WARN]", "[languagePackManager.js]", "無網路連線，無法下載語言包:", lang);
    updateCallback('無網路連線，請檢查網路後重試');
    return false;
  }

  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    console.error("[ERROR]", "[languagePackManager.js]", "未找到下載語言包按鍵");
    updateCallback('未找到下載語言包按鍵');
    return false;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.downloading) {
    console.info("[INFO]", "[languagePackManager.js]", "語言包正在下載:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
    updateCallback(`語言 ${lang} 的語言包正在下載`);
    return false;
  }

  if (!status.downloadable) {
    console.warn("[WARN]", "[languagePackManager.js]", "語言包不可下載:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '語言包不可用';
    updateCallback(`語言 ${lang} 的語言包不可下載`);
    return false;
  }

  try {
    console.info("[INFO]", "[languagePackManager.js]", "開始下載語言包:", lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
    
    const options = { langs: [lang], processLocally: true };
    const success = await SpeechRecognition.install(options);
    if (success) {
      console.info("[INFO]", "[languagePackManager.js]", `語言包 ${lang} 安裝成功`);
      downloadButton.textContent = '語言包已下載';
      downloadButton.disabled = true;
      updateCallback(`語言 ${lang} 的本地語音辨識已準備就緒`);
      return true;
    } else {
      console.error("[ERROR]", "[languagePackManager.js]", `無法安裝語言包 ${lang}，可能是語言不支援或下載問題`);
      downloadButton.disabled = false;
      downloadButton.textContent = '下載語言包';
      updateCallback(`語言 ${lang} 的語言包下載失敗，請重試`);
      return false;
    }
  } catch (error) {
    console.error("[ERROR]", "[languagePackManager.js]", "下載語言包失敗:", { error: error.message, stack: error.stack });
    downloadButton.disabled = false;
    downloadButton.textContent = '下載語言包';
    updateCallback(`語言 ${lang} 的語言包下載失敗，請重試`);
    return false;
  }
}

// 更新下載語言包按鍵的狀態
async function updateLanguagePackButton(lang) {
  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    console.debug("[DEBUG]", "[languagePackManager.js]", "未找到下載語言包按鍵，跳過更新");
    return;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.supported) {
    downloadButton.textContent = '語言包已下載';
    downloadButton.disabled = true;
  } else if (status.downloadable) {
    downloadButton.disabled = false;
    downloadButton.textContent = '下載語言包';
  } else if (status.downloading) {
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
  } else {
    console.warn("[WARN]", "[languagePackManager.js]", "語言包不可用", { lang, status, apiSupport: typeof SpeechRecognition.available });
    downloadButton.disabled = true;
    downloadButton.textContent = '語言包不可用';
  }
  console.debug("[DEBUG]", "[languagePackManager.js]", "更新語言包按鍵狀態:", { lang, status });
}

// 設置下載語言包按鍵的事件處理
async function setupLanguagePackButton(languageSelectorId, updateCallback) {
  const speechLangPack = document.getElementById('download-language-pack');
  if (!speechLangPack) {
    console.error("[ERROR]", "[languagePackManager.js]", "未找到下載語言包按鍵");
    updateCallback('未找到下載語言包按鍵');
    return;
  }

  const sourceLanguageSelect = document.getElementById(languageSelectorId);
  if (!sourceLanguageSelect) {
    console.error("[ERROR]", "[languagePackManager.js]", "未找到語言選擇器:", languageSelectorId);
    updateCallback('未找到語言選擇器');
    return;
  }

  // 初始化按鍵狀態
  const initialLang = sourceLanguageSelect.value || 'ja-JP';
  console.debug("[DEBUG]", "[languagePackManager.js]", "初始化語言:", { initialLang, selectValue: sourceLanguageSelect.value });
  await updateLanguagePackButton(initialLang);

  // 綁定點擊事件
  speechLangPack.addEventListener('click', async () => {
    const sourceLang = sourceLanguageSelect.value || 'ja-JP';
    console.debug("[DEBUG]", "[languagePackManager.js]", "點擊時語言:", { sourceLang });
    try {
      console.debug("[DEBUG]", "[languagePackManager.js]", "開始檢查語言包狀態", { lang: sourceLang });
      const status = await isLanguageSupportedLocally(sourceLang);

      if (status.supported) {
        console.info("[INFO]", "[languagePackManager.js]", "語言包已可用，無需下載", { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的本地語音辨識已準備就緒`);
        return;
      }

      if (status.downloadable) {
        console.info("[INFO]", "[languagePackManager.js]", "語言包可下載，開始下載流程", { lang: sourceLang });
        await downloadLanguagePack(sourceLang, updateCallback);
      } else if (status.downloading) {
        console.debug("[DEBUG]", "[languagePackManager.js]", "語言包正在下載中", { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的語言包正在下載`);
      } else {
        console.warn("[WARN]", "[languagePackManager.js]", "語言包不可用", { lang: sourceLang, status });
        updateCallback(`語言 ${sourceLang} 的本地語音辨識不可用`);
      }
    } catch (error) {
      console.error("[ERROR]", "[languagePackManager.js]", "點擊下載語言包時產生錯誤", error);
      updateCallback('檢查語言包失敗，請重試');
    }
  });

  // 語言切換時更新按鍵狀態
  sourceLanguageSelect.addEventListener('change', async () => {
    const newLang = sourceLanguageSelect.value;
    console.debug("[DEBUG]", "[languagePackManager.js]", "語言選擇器變更:", { newLang });
    await updateLanguagePackButton(newLang);
    console.info("[INFO]", "[languagePackManager.js]", "語言切換後更新按鍵狀態", { lang: newLang });
  });
}

export { isLanguageSupportedLocally, downloadLanguagePack, updateLanguagePackButton, setupLanguagePackButton };