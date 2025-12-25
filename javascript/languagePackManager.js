/**
 * @file languagePackManager.js
 * @description 語音語言包管理模組。負責檢測瀏覽器本地語音辨識支援度及執行模型安裝程序。
 * 2025 優化版：採用統一語系物件存取模式。
 */

import { updateStatusDisplay } from './translationController.js';
import { getLang } from './config.js'; // [修改] 引入 getLang 取代舊有分散函式
import { Logger } from './logger.js';

// #region [狀態檢查邏輯]

/**
 * 檢查指定語言是否支援本地語音辨識
 * @async
 * @param {string} langId - 語言 ID (如 'ja-JP')
 * @returns {Promise<{supported: boolean, downloadable: boolean, downloading: boolean}>}
 */
async function isLanguageSupportedLocally(langId) {
  // [修改] 確保該語系在設定中存在
  const langObj = getLang(langId);
  if (!langObj) return { supported: false, downloadable: false, downloading: false };

  const options = { langs: [langObj.id], processLocally: true };
  
  try {
    /* 技術備註：SpeechRecognition.available 是 2025 Chrome 用於查詢裝置語音模型狀態的標準 API */
    const status = await SpeechRecognition.available(options);
    Logger.debug("[DEBUG]", "[languagePackManager]", "檢查語言包支援:", { id: langObj.id, status });
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
// #endregion

// #region [下載核心邏輯]

/**
 * 執行指定語言包的下載與安裝
 * @async
 * @param {string} langId - 語言 ID
 * @param {Function} updateCallback - 狀態回傳回呼函式
 * @returns {Promise<boolean>}
 */
async function downloadLanguagePack(langId, updateCallback) {
  if (!navigator.onLine) {
    Logger.warn("[WARN]", "[languagePackManager]", "無網路連線:", langId);
    updateCallback('網路未連接，請檢查網路後再試。');
    return false;
  }

  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) {
    Logger.error("[ERROR]", "[languagePackManager]", "未找到下載按鍵");
    return false;
  }

  const langObj = getLang(langId); // [修改] 獲取統一物件
  const status = await isLanguageSupportedLocally(langId);

  if (status.downloading) {
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中…'; 
    updateCallback(`「${langObj.label}」の言語パックをダウンロードしています`);
    return false;
  }

  if (!status.downloadable) {
    downloadButton.disabled = true;
    downloadButton.textContent = '無法下載';
    updateCallback(`「${langObj.label}」の言語パックはダウンロードできません`);
    return false;
  }

  try {
    Logger.info("[INFO]", "[languagePackManager]", "開始下載語言包:", langObj.id);
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中…';
    
    const options = { langs: [langObj.id], processLocally: true };
    const success = await SpeechRecognition.install(options);
    
    if (success) {
      Logger.info("[INFO]", "[languagePackManager]", `語言包 ${langObj.id} 安裝成功`);
      downloadButton.textContent = '已下載';
      downloadButton.disabled = true;
      updateCallback(`「${langObj.label}」のローカル音声認識の準備が整いました。利用するにはブラウザの再起動が必要です。`);
      return true;
    } else {
      downloadButton.disabled = false;
      downloadButton.textContent = '下載失敗';
      updateCallback(`「${langObj.label}」の言語パックの下載に失敗しました。再試行してください。`);
      return false;
    }
  } catch (error) {
    Logger.error("[ERROR]", "[languagePackManager]", "下載異常:", { error: error.message });
    downloadButton.disabled = false;
    downloadButton.textContent = '下載失敗';
    return false;
  }
}
// #endregion

// #region [UI 與事件管理]

/**
 * 根據語言包狀態更新 UI 按鈕樣式
 * @async
 * @param {string} langId 
 */
async function updateLanguagePackButton(langId) {
  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) return;

  const langObj = getLang(langId);
  if (!langObj) {
    downloadButton.disabled = true;
    downloadButton.textContent = '不支援';
    return;
  }

  /* * 技術備註：目前 Chrome 核心對 zh-TW/cmn-Hant-TW 的本地語音辨識支援仍不穩定。
   * [修改] 這裡改用物件屬性判斷，增加維護性。
   */
  if (langObj.id === 'cmn-Hant-TW' || langObj.languageModelApiCode === 'zh-TW') {
    downloadButton.disabled = true;
    downloadButton.textContent = '暫不支援';
    return;
  }

  const status = await isLanguageSupportedLocally(langId);
  if (status.supported) {
    downloadButton.textContent = '已下載';
    downloadButton.disabled = true;
  } else if (status.downloadable) {
    downloadButton.disabled = false;
    downloadButton.textContent = '下載語言包';
  } else if (status.downloading) {
    downloadButton.disabled = true;
    downloadButton.textContent = '下載中…';
  } else {
    downloadButton.disabled = true;
    downloadButton.textContent = '不支援本地';
  }
}

/**
 * 綁定語言選擇器與下載按鍵的連動邏輯
 * @async
 * @param {string} languageSelectorId - 下拉選單的 DOM ID
 * @param {Function} updateCallback - 狀態回呼函式
 */
async function setupLanguagePackButton(languageSelectorId, updateCallback) {
  const speechLangPack = document.getElementById('download-language-pack');
  const sourceLanguageSelect = document.getElementById(languageSelectorId);

  if (!speechLangPack || !sourceLanguageSelect) {
    Logger.error("[ERROR]", "[languagePackManager]", "初始化失敗：元件未找到");
    return;
  }

  // 初始化狀態
  await updateLanguagePackButton(sourceLanguageSelect.value);

  // 點擊觸發下載程序
  speechLangPack.addEventListener('click', async () => {
    const langId = sourceLanguageSelect.value;
    const langObj = getLang(langId);
    if (!langObj) return;

    try {
      const status = await isLanguageSupportedLocally(langId);

      if (status.supported) {
        updateCallback(`「${langObj.label}」のローカル音声認識の準備が整いました。`);
        return;
      }

      if (status.downloadable) {
        await downloadLanguagePack(langId, updateCallback);
      }
    } catch (error) {
      Logger.error("[ERROR]", "[languagePackManager]", "執行點擊邏輯失敗", error);
    }
  });

  // 語言切換同步更新
  sourceLanguageSelect.addEventListener('change', async () => {
    await updateLanguagePackButton(sourceLanguageSelect.value);
  });
}
// #endregion

export { isLanguageSupportedLocally, downloadLanguagePack, updateLanguagePackButton, setupLanguagePackButton };