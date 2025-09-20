// 檢查指定語言是否支援本地語音辨識
async function isLanguageSupportedLocally(lang) {
  const options = { langs: [lang], processLocally: true };
  try {
    // 模擬 SpeechRecognition.available API，假設 ja-JP 和 en-US 已支援
    // 實際應用需替換為真實 API：await SpeechRecognition.available(options)
    const status = ['ja-JP', 'en-US'].includes(lang) ? 'available' : 'downloadable';
    console.debug('[DEBUG] [LanguagePackManager] 檢查語言包支援:', { lang, status });
    return {
      supported: status === 'available',
      downloadable: status === 'downloadable',
      downloading: status === 'downloading'
    };
  } catch (error) {
    console.error('[ERROR] [LanguagePackManager] 檢查語言包狀態失敗:', error);
    return { supported: false, downloadable: false, downloading: false };
  }
}

// 下載指定語言的語言包
async function downloadLanguagePack(lang, updateCallback) {
  if (!navigator.onLine) {
    console.warn('[WARN] [LanguagePackManager] 無網路連線，無法下載語言包:', lang);
    updateCallback('無網路連線，請檢查網路後重試');
    return false;
  }

  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    console.error('[ERROR] [LanguagePackManager] 未找到下載語言包按鍵');
    updateCallback('未找到下載語言包按鍵');
    return false;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.downloading) {
    console.info('[INFO] [LanguagePackManager] 語言包正在下載:', lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
    updateCallback(`語言 ${lang} 的語言包正在下載`);
    return false;
  }

  if (!status.downloadable) {
    console.warn('[WARN] [LanguagePackManager] 語言包不可下載:', lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '語言包不可用';
    updateCallback(`語言 ${lang} 的語言包不可下載`);
    return false;
  }

  try {
    console.info('[INFO] [LanguagePackManager] 開始下載語言包:', lang);
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
    
    // 模擬下載過程，實際應用需替換為 SpeechRecognition.install
    // 假設 API：await SpeechRecognition.install({ langs: [lang], processLocally: true });
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.info('[INFO] [LanguagePackManager] 語言包下載完成:', lang);
    downloadButton.textContent = '語言包已下載';
    downloadButton.disabled = true;
    updateCallback(`語言 ${lang} 的本地語音辨識已準備就緒`);
    return true;
  } catch (error) {
    console.error('[ERROR] [LanguagePackManager] 下載語言包失敗:', error);
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
    console.debug('[DEBUG] [LanguagePackManager] 未找到下載語言包按鍵，跳過更新');
    return;
  }

  const status = await isLanguageSupportedLocally(lang);
  if (status.supported) {
    //downloadButton.disabled = true;
    downloadButton.textContent = '語言包已下載';
  } else if (status.downloadable) {
    downloadButton.disabled = false;
    downloadButton.textContent = '下載語言包';
  } else if (status.downloading) {
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中...';
  } else {
    downloadButton.disabled = true;
    downloadButton.textContent = '語言包不可用';
  }
  console.debug('[DEBUG] [LanguagePackManager] 更新語言包按鍵狀態:', { lang, status });
}

// 設置下載語言包按鍵的事件處理
async function setupLanguagePackButton(languageSelectorId, updateCallback) {
  const speechLangPack = document.getElementById('download-language-pack');
  if (!speechLangPack) {
    console.error('[ERROR] [LanguagePackManager] 未找到下載語言包按鍵');
    updateCallback('未找到下載語言包按鍵');
    return;
  }

  const sourceLanguageSelect = document.getElementById(languageSelectorId);
  if (!sourceLanguageSelect) {
    console.error('[ERROR] [LanguagePackManager] 未找到語言選擇器:', languageSelectorId);
    updateCallback('未找到語言選擇器');
    return;
  }

  // 初始化按鍵狀態
  const initialLang = sourceLanguageSelect.value || 'ja-JP';
  await updateLanguagePackButton(initialLang);

  // 綁定點擊事件
  speechLangPack.addEventListener('click', async () => {
    const sourceLang = sourceLanguageSelect.value || 'ja-JP';
    try {
      console.debug('[DEBUG] [LanguagePackManager] 開始檢查語言包狀態', { lang: sourceLang });
      const status = await isLanguageSupportedLocally(sourceLang);

      if (status.supported) {
        console.info('[INFO] [LanguagePackManager] 語言包已可用，無需下載', { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的本地語音辨識已準備就緒`);
        return;
      }

      if (status.downloadable) {
        console.info('[INFO] [LanguagePackManager] 語言包可下載，開始下載流程', { lang: sourceLang });
        await downloadLanguagePack(sourceLang, updateCallback);
      } else if (status.downloading) {
        console.debug('[DEBUG] [LanguagePackManager] 語言包正在下載中', { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的語言包正在下載`);
      } else {
        console.warn('[WARN] [LanguagePackManager] 語言包不可用', { lang: sourceLang });
        updateCallback(`語言 ${sourceLang} 的本地語音辨識不可用`);
      }
    } catch (error) {
      console.error('[ERROR] [LanguagePackManager] 點擊下載語言包時產生錯誤', error);
      updateCallback('檢查語言包失敗，請重試');
    }
  });

  // 語言切換時更新按鍵狀態
  sourceLanguageSelect.addEventListener('change', async () => {
    const newLang = sourceLanguageSelect.value;
    await updateLanguagePackButton(newLang);
    console.info('[INFO] [LanguagePackManager] 語言切換後更新按鍵狀態', { lang: newLang });
  });
}

export { isLanguageSupportedLocally, downloadLanguagePack, updateLanguagePackButton, setupLanguagePackButton };