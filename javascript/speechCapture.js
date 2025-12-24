/**
 * @file speechCapture.js
 * @description 語音擷取與辨識核心邏輯。支援 Web Speech API 與 Deepgram 雙模組分流。
 * 針對 Gemini 3.0 翻譯引擎進行了前置文字清理優化。
 */

import { isRayModeActive, isDeepgramActive, browserInfo, getSourceLanguage, getLang } from './config.js';
import { sendTranslationRequest, updateStatusDisplay } from './translationController.js';
import { startDeepgram, stopDeepgram } from './deepgramService.js';
import { Logger } from './logger.js';

// #region [狀態變數與快取]

/** @type {boolean} 是否已顯示過麥克風資訊 */
let hasShownMicInfo = false;

/** @type {SpeechRecognition|null} Web Speech API 辨識實例 */
let recognition = null;

/** @type {boolean} 全域辨識啟用狀態 */
let isRecognitionActive = false;

/** @type {Array<Object>} Ray Mode 關鍵字規則集 */
let keywordRules = [];

/** @type {Map<string, Array<Object>>} 以語言為 Key 的正規表達式規則快取 */
const cachedRules = new Map();

/** @type {Object} 短語庫配置物件 */
let phrasesConfig = {};

/** @type {Map<string, Array<SpeechRecognitionPhrase>>} 已實例化的短語物件快取 */
const cachedPhrases = new Map();

/** @type {string} 存儲上一次發送翻譯的文字，用於上下文比對 */
let previousText = '';

// #endregion

// #region [硬體檢測與 UI 控制]

/**
 * 檢測並顯示目前瀏覽器佔用的音訊輸入裝置資訊
 * @async
 * @returns {Promise<void>}
 */
async function showMicInfoOnce() {
  if (hasShownMicInfo) return;
  hasShownMicInfo = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    Logger.warn('[WARN] [SpeechRecognition] 此瀏覽器不支援 mediaDevices.enumerateDevices()');
    return;
  }

  let tempStream = null;
  try {
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      Logger.warn('[WARN] [SpeechRecognition] 取得麥克風權限失敗（名稱可能會顯示為空）:', err);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const micInfoEl = document.getElementById('default-mic');
    const otherMicEl = document.getElementById('other-mic');
    if (!audioInputs.length) {
      const msg = '利用可能な音声入力デバイスが見つかりません。マイクが正しく接続されているか、システムの設定をご確認ください。';
      Logger.info('[INFO] [SpeechRecognition]', msg);
      if (micInfoEl) micInfoEl.textContent = msg;
      return;
    }

    const defaultDevice = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0];

    let infoText = `\n- ${defaultDevice.label || 'デバイス名を取得できませんでした'}\n\n(※ 音声認識には通常、この既定のデバイスが使用されます。)`;
    let otherMic = 'その他の利用可能な音声入力デバイス：\n'; 
    if (audioInputs.length > 1) {
      audioInputs
        .filter(d => d !== defaultDevice)
        .forEach((d, idx) => {
          otherMic += `\n${idx + 1}. ${d.label || d.deviceId}`;
        });
    }

    Logger.info('[INFO] [SpeechRecognition] 偵測到的裝置列表:', audioInputs);
    if (micInfoEl) micInfoEl.textContent = infoText;
    if (otherMicEl) otherMicEl.textContent = otherMic;
  } catch (err) {
    Logger.error('[ERROR] [SpeechRecognition] 取得麥克風資訊失敗:', err);
  } finally {
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
  }
}

/**
 * 切換錄音控制按鈕的 DOM 狀態
 * @param {boolean} isStarting - 是否進入啟動流程
 */
function setRecognitionControlsState(isStarting) {
  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');

  if (isStarting) {
    startButton.disabled = true;
    stopButton.disabled = false;
  } else {
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}

// #endregion

// #region [語音辨識核心配置]

/**
 * 初始化 Web Speech API Recognition 參數
 * @async
 * @param {SpeechRecognition} recognition - 辨識實例
 * @throws {Error} 若未選擇語系則中斷執行
 */
async function configureRecognition(recognition, sourceLanguage) {

  const processLocallyStatus = await decideProcessLocally(sourceLanguage);

  /* 技術備註：目前 Chrome 核心在本地模型存在時，processLocally 會強制覆蓋雲端辨識 */
  if (browserInfo.isChrome) { recognition.processLocally = processLocallyStatus; }
  
  recognition.interimResults = true;
  recognition.lang = getLang(sourceLanguage)?.commentLangCode;
  recognition.continuous = processLocallyStatus;
  recognition.maxAlternatives = 1;

  if (browserInfo.isChrome && recognition.processLocally && 'phrases' in recognition) {
    const selectedPhrases = getPhrasesForLang(sourceLanguage);
    recognition.phrases = selectedPhrases.length > 0 ? selectedPhrases : [];
  } else {
    recognition.phrases = [];
  }

  Logger.debug('[DEBUG] [SpeechRecognition] 辨識參數已就緒:', {
    lang: recognition.lang,
    processLocally: recognition.processLocally,
    phrasesCount: recognition.phrases.length
  });
}

/**
 * [修改] 處理來自 Deepgram 服務的串流回傳值
 * * @param {string} text - 目前完整的顯示文字 (由 Service 組裝好)
 * @param {boolean} isFinal - 是否為確認文字 (控制 UI 變色)
 * @param {boolean} shouldTranslate - [新增] 是否觸發翻譯請求 (控制翻譯)
 */
async function handleDeepgramTranscript(text, isFinal, shouldTranslate) {
  const currentLang = await getSourceLanguage();
  let processedText = isRayModeActive() ? processRayModeTranscript(text, currentLang) : text;
  
  if (!isFinal) { processedText = wrapWithNoteByAlignment(processedText); }
  updateSourceText(processedText.replace(/[、。？\s]+/g, ' ').trim());

  if (shouldTranslate) {
    const textToTranslate = processedText.trim();
    if (textToTranslate) {
        Logger.info('[INFO] [Deepgram] 收到 Service 指令，執行翻譯:', textToTranslate);
        
        sendTranslationRequest(textToTranslate, previousText, currentLang);
        previousText = textToTranslate;
        updateSourceText(textToTranslate.replace(/[、。？\s]+/g, ' ').trim()); 
        return; 
    }
  }
}

// #endregion

// #region [規則載入與文字過濾]

/** 異步載入 Ray Mode 字詞轉換規則 */
async function loadKeywordRules() {
  try {
    const response = await fetch('data/ray_mode_keywords.json');
    if (!response.ok) throw new Error('無法載入關鍵字規則');

    keywordRules = await response.json();
    const uniqueLangs = [...new Set(keywordRules.map(rule => rule.lang))];
    uniqueLangs.forEach(lang => {
      cachedRules.set(lang, keywordRules
                 .filter(rule => rule.lang === lang)
                 .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
    });
    Logger.info('[INFO] [SpeechRecognition] 關鍵字規則載入完成');
  } catch (error) {
    Logger.error('[ERROR] [SpeechRecognition] 載入規則失敗:', error);
  }
}

/** 異步載入語音短語增強配置 (Chrome 141+ 支援) */
async function loadPhrasesConfig() {
  try {
    const response = await fetch('data/phrases_config.json');
    if (!response.ok) throw new Error('無法載入 phrases 配置');

    phrasesConfig = await response.json();
    Object.keys(phrasesConfig.languages || {}).forEach(lang => {
      const langData = phrasesConfig.languages[lang] || [];
      let phraseObjects = [];
      if (typeof SpeechRecognitionPhrase !== 'undefined') {
        phraseObjects = langData.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost));
      }
      cachedPhrases.set(lang, phraseObjects);
    });

    if (phrasesConfig.defaults && typeof SpeechRecognitionPhrase !== 'undefined') {
      cachedPhrases.set('default', phrasesConfig.defaults.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost)));
    }
  } catch (error) {
    Logger.error('[ERROR] [SpeechRecognition] 載入短語配置失敗:', error);
    phrasesConfig = { languages: {} };
  }
}

/** 獲取快取的語言短語 */
function getPhrasesForLang(sourceLang) {
  return cachedPhrases.get(sourceLang) || cachedPhrases.get('default') || [];
}

/** 獲取快取的 Ray Mode 轉換規則 */
function generateRayModeRules(sourceLang) {
  return cachedRules.get(sourceLang) || [];
}

/** * 過濾並清理辨識文字中的特殊符號與無效片段
 * @param {string} text 
 * @param {string} sourceLang 
 * @returns {string} 清理後的文字
 */
function filterRayModeText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ'|| text.trim() === 'っ。') {
    return '';
  }

  let result = text.replace(/[、。？,.]/g, ' '); // 預先移除標點以利 Gemini 語意切分
  const rules = generateRayModeRules(sourceLang);
  rules.forEach(rule => { result = result.replace(rule.source, rule.target); });

  return result;
}

/** 偵測瀏覽器是否支援本地辨識模式 */
async function decideProcessLocally(lang) {
  if (!browserInfo.isChrome) return true;
  if (!('SpeechRecognition' in window) || !SpeechRecognition.available) return false;
  try {
    const status = await SpeechRecognition.available({ langs: [lang], processLocally: true });
    return status === 'available';
  } catch (e) {
    return false;
  }
}

// #endregion

// #region [UI 更新與顯示邏輯]

/**
 * 更新字幕顯示區域
 * @param {string} text - 辨識文字
 */
function updateSourceText(text) {
  const el = document.getElementById('source-text');
  if (!el || !text || text.trim().length === 0 || el.textContent === text) return;

  el.textContent = text;
  el.dataset.stroke = text;
}

/**
 * 根據視覺對齊方式添加動態音符裝飾
 * @param {string} baseText 
 * @returns {string} 裝飾後的文字
 */
function wrapWithNoteByAlignment(baseText) {
  const alignment = document.querySelector('input[name="alignment"]:checked')?.value || 'left';
  return alignment === 'center' ? `🎼️${baseText}🎼` :
         alignment === 'right'  ? `🎼${baseText}` :
                                  `${baseText}🎼`;
}

/** 重置所有字幕顯示欄位 */
function clearAllTextElements() {
  const els = document.querySelectorAll('#source-text, #target-text-1, #target-text-2, #target-text-3');
  for (const el of els) {
    try { if (el.getAnimations) el.getAnimations().forEach(a => a.cancel()); } catch (e) {}
    el.textContent = '';
    el.dataset.stroke = '';
  }
}

// #endregion

// #region [語音辨識控制流程]

/**
 * 初始化語音辨識實體與生命週期事件
 * @returns {SpeechRecognition|null}
 */
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition;
  if (!SpeechRecognition) return null;

  const newRecognition = new SpeechRecognition();
  let finalTranscript = '';
  let interimTranscript = '';

  newRecognition.onresult = async (event) => {
    let hasFinalResult = false;
    interimTranscript = '';
    finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
        hasFinalResult = true;
      } else {
        interimTranscript += transcript;
      }
    }

    if (hasFinalResult) {
      /* 核心邏輯：移除標點後發送翻譯請求，避免標點符號干擾 AI 斷句語意 */
      
      let sendTranslationRequestText = finalTranscript.replace(/[、。？\s]+/g, ' ').trim();
      if (isRayModeActive()) { sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, newRecognition.lang); }

      Logger.info('[INFO] [SpeechRecognition] 發送翻譯請求文字:', sendTranslationRequestText);
      sendTranslationRequest(sendTranslationRequestText, previousText, newRecognition.lang);
      previousText = sendTranslationRequestText;
    }

    const fullTextRaw = `${finalTranscript} ${interimTranscript}`.replace(/[、。？\s]+/g, ' ').trim();
    let processedText = isRayModeActive() ? processRayModeTranscript(fullTextRaw, newRecognition.lang) : fullTextRaw;
    
    if (!hasFinalResult) { processedText = wrapWithNoteByAlignment(processedText); }
    updateSourceText(processedText);
  };

  newRecognition.onnomatch = () => Logger.warn('[WARN] [SpeechRecognition] 無匹配辨識結果');
  newRecognition.onend = () => { Logger.debug('[DEBUG] [SpeechRecognition] onend事件觸發'); autoRestartRecognition(); }
  newRecognition.onerror = (event) => {
    if (event.error !== 'aborted') Logger.error('[ERROR] [SpeechRecognition] 辨識錯誤:', event.error);
  };

  return newRecognition;
}

/**
 * 處理 Web Speech API 的斷線自動重連機制
 * @async
 * @param {Object} options 
 */
async function autoRestartRecognition(options = { delay: 0 }) {
  if (!isRecognitionActive) return;

  setTimeout(async () => {
    try {
      recognition.start();
      options.delay = 0;
    } catch (error) {
      if (options.delay < 1000) options.delay += 200;
      setTimeout(() => autoRestartRecognition(options), options.delay);
    }
  }, options.delay);
}

/** Ray Mode 內部文字過濾呼叫 */
function processRayModeTranscript(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ'  || text.trim() === 'っ。') return '';
  let result = text.replace(/[、。？,.]/g, ' ');
  const rules = generateRayModeRules(sourceLang);
  rules.forEach(rule => { result = result.replace(rule.source, rule.target); });
  return result;
}

// #endregion

// #region [事件掛載與生命週期]

/** 綁定 UI 操作按鈕與語音服務啟動邏輯 */
function setupSpeechRecognitionHandlers() {
  if (!window.SpeechRecognition || browserInfo.browser === 'Unknown') return;

  recognition = setupSpeechRecognition();
  if (!recognition) return;

  const [startButton, stopButton] = ['start-recording', 'stop-recording'].map(id => document.getElementById(id));

  startButton.addEventListener('click', async () => {
    updateStatusDisplay(''); 
    const sourceLang = await getSourceLanguage();
    if (!sourceLang) {
      updateStatusDisplay('音声認識を始める前に、音声認識言語を選択してください。');
      return;
    }

    clearAllTextElements();

    /* Deepgram 優先權邏輯：若啟用 Deepgram 則嘗試啟動，失敗後 Fallback 至 Web Speech API */
    if (isDeepgramActive()) {
      try {
        const deepgramStarted = await startDeepgram(sourceLang, handleDeepgramTranscript);
        if (deepgramStarted) {
          setRecognitionControlsState(true);
          isRecognitionActive = true;
          return; 
        }
      } catch (err) {
        Logger.error('[ERROR] [SpeechRecognition] Deepgram 啟動失敗:', err);
      }
    }

    setRecognitionControlsState(true);
    isRecognitionActive = true;
    await configureRecognition(recognition, sourceLang);
    try {
      recognition.start();
    } catch (error) {
      setRecognitionControlsState(false);
      isRecognitionActive = false;
    }
  });

  stopButton.addEventListener('click', () => {
    setRecognitionControlsState(false);
    isRecognitionActive = false;
    if (isDeepgramActive()) stopDeepgram();
    if (recognition) { recognition.abort(); clearAllTextElements(); }
  });
}

/** 頁面初始化與卸載處理 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadKeywordRules();
  await loadPhrasesConfig();
  setupSpeechRecognitionHandlers();
  setRecognitionControlsState(false);
  isRecognitionActive = false;

  showMicInfoOnce().catch(() => {});

  window.addEventListener('beforeunload', () => {
    if (isDeepgramActive()) stopDeepgram();
  });
});

// #endregion

export { keywordRules, setRecognitionControlsState, clearAllTextElements };