/**
 * @file languagePackManager.js
 * @description 語音語言包管理模組。負責檢測瀏覽器本地語音辨識支援度及執行模型安裝程序。
 * 由 uiController.js 在初始化時透過 setupLanguagePackButton() 綁定
 * 「オフラインパック」下載按鈕（index.html 的 #download-language-pack）。
 *
 * 兩個實測得到的重點，改動前請先讀：
 *
 * 1. install() 回傳 true 不等於裝好了。它只代表「請求被接受」，
 *    對於瀏覽器根本沒有模型的語言也會回 true，而 available() 會永遠停在
 *    'downloadable'。所以安裝後一定要輪詢 available() 才能說裝好。
 *
 * 2. install() 必須是點擊事件裡第一個 await 的呼叫。中間只要先 await 過別的東西
 *    （例如 available()），user gesture 就被消耗掉，install() 會以
 *    NotAllowedError 被拒絕。因此按鈕的可按狀態由語言切換時的檢查決定，
 *    點下去之後不再重新檢查。
 */

import { getLang } from './config.js';
import { createLogger } from './logger.js';
import { isWebSpeechRecognitionRunning } from './speechCapture.js';

const log = createLogger('LanguagePackManager');

// #region [常數]

/* en-US 是 SODA 的基礎模型：安裝任何語言包都會連帶拉 en-US，
   而且 en-US 沒下載完之前辨識也不能用。列在這裡不會改變結果，
   只是把等待提前到同一次 install() 裡，而不是讓它默默發生。 */
const PRIMER_LANG = 'en-US';

/* install() 會在下載真正完成之前就 resolve，所以要輪詢 available() 直到模型就緒。 */
const INSTALL_POLL_INTERVAL_MS = 1500;
const INSTALL_POLL_TIMEOUT_MS  = 60000;

/* 可接受的本地模型品質下限，好的排前面。規格上 quality 是「達到或超過」的下限，
   所以先探最好的，沒有模型滿足時再退到低的。目前只有 'command' 包，
   等 'dictation' 包上線就會自動接上，不用改程式。
   舊版瀏覽器與 Edge 會忽略不認識的 quality，等於 no-op。
   注意 'standard' 不是合法值，會丟 TypeError。 */
const QUALITY_PREFERENCE = ['dictation', 'command'];

/** 最近一次檢查得到的可安裝品質下限。install() 不能先 await 檢查，所以沿用這個值。 */
let installQuality = QUALITY_PREFERENCE[QUALITY_PREFERENCE.length - 1];

// #endregion

// #region [狀態檢查邏輯]

/**
 * 檢查指定語言是否支援本地語音辨識
 * @async
 * @param {string} langId - 語言 ID (如 'ja-JP')
 * @returns {Promise<{supported: boolean, downloadable: boolean, downloading: boolean, quality: string|null}>}
 */
async function isLanguageSupportedLocally(langId) {
  const langObj = getLang(langId);
  const unavailable = { supported: false, downloadable: false, downloading: false, quality: null };
  if (!langObj) return unavailable;
  if (!('SpeechRecognition' in window) || typeof SpeechRecognition.available !== 'function') return unavailable;

  /* 由好到差逐一探測，第一個不是 'unavailable' 的就是實際會採用的品質。 */
  for (const quality of QUALITY_PREFERENCE) {
    try {
      const status = await SpeechRecognition.available({ langs: [langObj.id], processLocally: true, quality });
      log.debug("檢查語言包支援:", { id: langObj.id, quality, status });
      if (status !== 'unavailable') {
        return {
          supported: status === 'available',
          downloadable: status === 'downloadable',
          downloading: status === 'downloading',
          quality
        };
      }
    } catch (error) {
      log.error("檢查語言包狀態失敗:", error);
    }
  }
  return unavailable;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 輪詢 available() 直到模型真的可用，或逾時。
 * 用來繞過 install() 早於下載完成就 resolve 的行為。
 * @async
 * @param {string} langId
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitUntilInstalled(langId, timeoutMs = INSTALL_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isLanguageSupportedLocally(langId)).supported) return true;
    await delay(INSTALL_POLL_INTERVAL_MS);
  }
  return false;
}

// #endregion

// #region [UI 與事件管理]

/** 下載按鈕的顯示狀態 */
function setButtonState(text, disabled) {
  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) return;
  downloadButton.textContent = text;
  downloadButton.disabled = disabled;
}

/**
 * 根據語言包狀態更新 UI 按鈕樣式。
 * 按鈕可否點擊完全由這裡決定——點擊後不會再檢查一次（見檔頭第 2 點）。
 * @async
 * @param {string} langId
 */
async function updateLanguagePackButton(langId) {
  const downloadButton = document.getElementById('download-language-pack');
  if (!downloadButton) return;

  const langObj = getLang(langId);
  if (!langObj) return setButtonState('非対応', true);

  /* 技術備註：Chrome 沒有出中文的 SODA 模型，因此手動停用，中文一律走雲端辨識。
     install() 會回 true，但 available() 對 zh-TW / cmn-Hant-TW / zh-Hant-TW
     永遠停在 'downloadable'（純 'zh' 是 'unavailable'）。同一個工作階段裡
     en-US 是正常的，所以不是機制壞掉，也不是語言代碼寫錯——是模型根本不存在。
     要重測就把這段拿掉看 debug log：如果裝完之後下一次仍回報 processLocally:false，
     就代表狀況沒變。 */
  if (langObj.id === 'cmn-Hant-TW' || langObj.languageModelApiCode === 'zh-TW') {
    return setButtonState('一時的に非対応', true);
  }

  const status = await isLanguageSupportedLocally(langId);
  /* 記住要用哪個品質下限安裝——downloadLanguagePack() 不能先 await 檢查。 */
  if (status.quality) installQuality = status.quality;

  if (status.supported)         setButtonState('ダウンロード済み', true);
  else if (status.downloadable) setButtonState('ダウンロード', false);
  else if (status.downloading)  setButtonState('ダウンロード中…', true);
  else                          setButtonState('非対応', true);
}

/**
 * 執行指定語言包的下載與安裝。
 * 呼叫端必須在點擊事件中「同步」進入這裡，install() 之前不可以有任何 await。
 * @async
 * @param {string} langId - 語言 ID
 * @param {Function} updateCallback - 狀態回傳回呼函式
 * @returns {Promise<boolean>}
 */
async function downloadLanguagePack(langId, updateCallback) {
  const langObj = getLang(langId);
  if (!langObj) return false;

  if (!navigator.onLine) {
    log.warn("無網路連線:", langId);
    updateCallback('インターネットに接続されていません。ネットワークを確認してください。');
    return false;
  }

  setButtonState('ダウンロード中…', true);

  /* en-US 是連帶會被拉下來的基礎模型（見 PRIMER_LANG），
     併進同一次呼叫把下載時間提前，而不是分兩次等。 */
  const langs = langObj.id !== PRIMER_LANG ? [PRIMER_LANG, langObj.id] : [langObj.id];
  const quality = installQuality;

  let accepted = false;
  try {
    log.info("開始下載語言包:", { langs, quality });
    /* 這裡必須是第一個 await，否則 user gesture 會被消耗掉。 */
    accepted = await SpeechRecognition.install({ langs, processLocally: true, quality });
    log.debug("install() 回傳:", accepted);
  } catch (error) {
    log.error("下載異常:", { error: error.message });
  }

  /* available() 才是唯一可信的訊號。曾經因為相信 install() 的回傳值，
     對著辨識端根本拒絕使用的語言包顯示「已下載」，直到重新整理才露餡。
     真的裝好的話第一次輪詢就會通過並立刻返回。 */
  const installed = await waitUntilInstalled(langObj.id);
  if (accepted && !installed) {
    log.warn("install() 回傳 true 但模型始終沒有變成 available:", langObj.id);
  }

  if (installed) {
    log.info(`語言包 ${langObj.id} 安裝成功`);
    setButtonState('ダウンロード済み', true);
    /* オンラインとオフラインで認識パラメータが異なるため、認識中であれば
       一度停止し、オフライン用パラメータで再スタートしてもらう。 */
    if (isWebSpeechRecognitionRunning()) {
      document.getElementById('stop-recording')?.click();
    }
    updateCallback(`「${langObj.label}」のローカル音声認識を使用できるようになりました。もう一度「開始」を押してください。`);
    return true;
  }

  await updateLanguagePackButton(langId);
  updateCallback(`「${langObj.label}」の言語パックのダウンロードに失敗しました。もう一度お試しください。`);
  return false;
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
    log.error("初始化失敗：元件未找到");
    return;
  }

  // 初期状態
  await updateLanguagePackButton(sourceLanguageSelect.value);

  /* 按鈕能按就代表狀態是 downloadable，這裡不再檢查一次——
     多一個 await 就會讓 install() 拿不到 user gesture。 */
  speechLangPack.addEventListener('click', () => {
    downloadLanguagePack(sourceLanguageSelect.value, updateCallback);
  });

  // 語言切換同步更新
  sourceLanguageSelect.addEventListener('change', async () => {
    await updateLanguagePackButton(sourceLanguageSelect.value);
  });
}
// #endregion

export { isLanguageSupportedLocally, downloadLanguagePack, updateLanguagePackButton, setupLanguagePackButton };
