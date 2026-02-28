/**
 * @file speechCapture.js
 * @description 主要處理語音擷取前參數設定到產生逐字稿的相關邏輯。
 * 支援瀏覽器內建 Web Speech API (免費) 與 Deepgram (付費) 兩種方式。
 * 依據 index.html 的元素 ID [deepgram-enabled] 決定使用哪一種方式。
 */

import { isRayModeActive, isDeepgramActive, browserInfo, getSourceLanguage, getLang, getAlignment } from './config.js';
import { sendTranslationRequest, updateStatusDisplay } from './translationController.js';
import { startDeepgram, stopDeepgram } from './deepgramService.js';
import { isDebugEnabled } from './logger.js';

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
    if (isDebugEnabled()) console.warn('[WARN] [SpeechRecognition] 此瀏覽器不支援 mediaDevices.enumerateDevices()');
    return;
  }

  let tempStream = null;
  try {
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      if (isDebugEnabled()) console.warn('[WARN] [SpeechRecognition] 取得麥克風權限失敗（名稱可能會顯示為空）:', err);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const micInfoEl = document.getElementById('default-mic');
    const otherMicEl = document.getElementById('other-mic');
    if (!audioInputs.length) {
      const msg = '利用可能な音声入力デバイスが見つかりません。マイクが正しく接続されているか、システムの設定をご確認ください。';
      if (isDebugEnabled()) console.info('[INFO] [SpeechRecognition]', msg);
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

    if (isDebugEnabled()) console.info('[INFO] [SpeechRecognition] 偵測到的裝置列表:', audioInputs);
    if (micInfoEl) micInfoEl.textContent = infoText;
    if (otherMicEl) otherMicEl.textContent = otherMic;
  } catch (err) {
    if (isDebugEnabled()) console.error('[ERROR] [SpeechRecognition] 取得麥克風資訊失敗:', err);
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

  /* 
   * [注意] Web Speech API On-Device 模式目前僅 Chrome 支援。
   * 若 recognition.processLocally 設為 false，則無法使用自訂語句 (phrases)，強制使用會導致錯誤。
   * 
   * 目前設定：當 recognition.processLocally = true 且為 Chrome 時，recognition.continuous 設為 true。
   * 這是為了避免 onend 事件重啟期間若使用者仍在說話導致辨識中斷。
   */
  if (browserInfo.isChrome) { recognition.processLocally = processLocallyStatus; }

  recognition.interimResults = true;
  recognition.lang = sourceLanguage;
  /* 
   * [關於 continuous 參數]
   * Chrome: 強制 true 時，穩定運作時間可能較短。
   *   - On-Device 模式 (Chrome 144+): 建議 true。
   *   - Cloud 模式: 若設為 true，建議將 SILENCE_THRESHOLD 調低 (如 1000ms)，否則可能無法運作超過 10 分鐘。
   * Edge: 建議 true，無上述問題。
   */
  //recognition.continuous = true;
  recognition.continuous = processLocallyStatus;
  recognition.maxAlternatives = 1;

  if (browserInfo.isChrome && recognition.processLocally && 'phrases' in recognition) {
    const selectedPhrases = getPhrasesForLang(sourceLanguage);
    recognition.phrases = selectedPhrases.length > 0 ? selectedPhrases : [];
  } else {
    recognition.phrases = [];
  }

  if (isDebugEnabled()) console.debug('[DEBUG] [SpeechRecognition] 辨識參數已就緒:', {
    lang: recognition.lang,
    processLocally: recognition.processLocally,
    phrasesCount: recognition.phrases.length,
    continuous: recognition.continuous
  });
}

/**
 * 處理來自 Deepgram 服務的串流回傳值
 * @param {string} text - 目前完整的顯示文字
 * @param {boolean} isFinal - 是否為確認文字
 * @param {boolean} shouldTranslate - 是否觸發翻譯請求
 * @param {string} currentLang - 當前語言代碼
 */
async function handleDeepgramTranscript(text, isFinal, shouldTranslate, currentLang) {

  let processedText = isRayModeActive() ? processRayModeTranscript(text, currentLang) : text;
  const textToTranslate = processedText.trim();

  if (!isFinal) { processedText = wrapWithNoteByAlignment(processedText, 'deepgram'); }
  if (processedText.trim() !== '') { updateSourceText(processedText.replace(/[、。？\s]+/g, ' ').trim()); }

  if (shouldTranslate && processedText.trim() !== '') {
    if (textToTranslate) {
      if (isDebugEnabled()) console.info('[INFO] [Deepgram] 收到 Service 指令 (Speaker 0)，執行翻譯:', textToTranslate);

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
  const response = await fetch('data/ray_mode_keywords.json');
  if (!response.ok) throw new Error('無法載入關鍵字規則');

  keywordRules = await response.json();
  const uniqueLangs = [...new Set(keywordRules.map(r => r.lang))];

  uniqueLangs.forEach(lang => {
    const rulesForLang = keywordRules
      .filter(r => r.lang === lang)
      .map(r => ({
        sourcePattern: r.source,   // 仍然是「regex pattern 字串」
        target: r.target
      }))
      // 最長優先：避免短詞先吃掉長詞
      .sort((a, b) => b.sourcePattern.length - a.sourcePattern.length);

    // 預編譯：精準判斷是哪一條規則命中（避免每次都new RegExp）
    const compiledRules = rulesForLang.map(r => ({
      target: r.target,
      exact: new RegExp(`^(?:${r.sourcePattern})$`, 'i') // 不要 g，避免 lastIndex 問題
    }));

    // 預編譯：一次掃描用的 master regex
    const pattern = rulesForLang.map(r => `(?:${r.sourcePattern})`).join('|');
    const master = pattern ? new RegExp(pattern, 'ig') : null;

    cachedRules.set(lang, { rules: compiledRules, master });
  });
}

/** 
 * 載入辨識語句權重 (Phrases) 配置
 * [注意] 此功能需 Chrome 141+ 且透過 install 方式安裝的 Web App 才支援。
 * 目前若未滿足條件會導致錯誤，故程式碼中暫未全面啟用，保留供未來使用。
 */
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
    if (isDebugEnabled()) console.error('[ERROR] [SpeechRecognition] 載入短語配置失敗:', error);
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

/** 
 * 在 Ray mode 時進行的逐字稿文字替換處理
 * @param {string} text 
 * @param {string} sourceLang 
 * @returns {string} 清理後的文字
 */
function filterRayModeText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    return '';
  }

  let result = text.replace(/[、。？,.]/g, ' ');
  
  const pack = generateRayModeRules(sourceLang);
  
  if (!pack || !pack.master) {
    return result;
  }

  const { rules, master } = pack;

  try {
    result = result.replace(master, (match) => {
      const hit = rules.find(r => r.exact.test(match));
      return hit ? hit.target : match;
    });
  } catch (e) {
    if (isDebugEnabled()) console.error('[ERROR] filterRayModeText 替換失敗:', e);
  }

  return result;
}

/** 偵測瀏覽器是否支援本地辨識模式 */
async function decideProcessLocally(lang) {
  if (browserInfo.browser === 'Edge') return true; //Edge因為運作方式的關係直接true回傳比較不會有問題
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
const updateSourceText = (() => {
  let el = null;
  let lastRenderedText = '';

  return (text) => {
    if (!el) {
      el = document.getElementById('source-text');
      if (!el) return;
    }
    if (!text || text.trim().length === 0 || text === '。') return;
    if (text === lastRenderedText) { return; }
    el.textContent = text;
    lastRenderedText = text;
  };
})();

/**
 * 根據視覺對齊方式添加動態音符裝飾
 * @param {string} baseText 
 * @returns {string} 裝飾後的文字
 */
function wrapWithNoteByAlignment(baseText, symbolType) {
  const alignment = getAlignment();
  // deepgram api            → 🐹 
  // web speech api → Chrome → 🎵
  // web speech api → Edge   → 🎼️
  const symbolTextA = symbolType === 'deepgram' ? '​​🐹'
                         : browserInfo.isChrome ? '​​🐿️'
                                                : '​🐭';
  const symbolTextB = '🐹';

  return alignment === 'center' ? `${symbolTextA}${baseText}${symbolTextB}`
       : alignment === 'right'  ? `${symbolTextA}${baseText}`
                                : `${baseText}${symbolTextA}`;
}

/** 重置所有字幕顯示欄位 */
function clearAllTextElements() {
  const els = document.querySelectorAll('#source-text, #target-text-1, #target-text-2, #target-text-3');
  for (const el of els) {
    try { if (el.getAnimations) el.getAnimations().forEach(a => a.cancel()); } catch (e) { }
    el.textContent = '';
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



  let SILENCE_THRESHOLD = 1000;
  let silenceTimer = null;

  let finalTranscript = '';
  let interimTranscript = '';

  // 斷句計時器
  const resetSilenceTimer = () => {
    // Edge 重新啟動速度較慢，若使用計時器強制斷句，容易陷入「斷句 -> 重啟 -> 漏字 -> 錯亂」的循環。
    // 因此 Edge 環境下不啟用此計時器。
    if (!browserInfo.isChrome) return;

    if (silenceTimer) clearTimeout(silenceTimer);

    // 設定新的計時器
    silenceTimer = setTimeout(() => {
      if (isDebugEnabled()) console.debug(`[DEBUG] [SpeechRecognition] 偵測到靜音超過 ${SILENCE_THRESHOLD}ms，強制重啟`);

      if (interimTranscript.trim().length > 0) {
        let forcedFinalText = interimTranscript.replace(/[、。？\s]+/g, ' ').trim();
        
        if (isRayModeActive()) {
           forcedFinalText = processRayModeTranscript(forcedFinalText, newRecognition.lang);
        }

        if (forcedFinalText) {
          if (isDebugEnabled()) console.info('[INFO] [SpeechRecognition] (強制斷句) 發送翻譯請求文字:', forcedFinalText);
          sendTranslationRequest(forcedFinalText, previousText, newRecognition.lang);
          previousText = forcedFinalText;
          updateSourceText(forcedFinalText);
        }
      }
      newRecognition.abort(); 

    }, SILENCE_THRESHOLD);
  };

  newRecognition.onsoundstart = () => {
    if (isDebugEnabled()) console.debug('[DEBUG] [SpeechRecognition] soundstart事件觸發');
    if (newRecognition.continuous) { 
      SILENCE_THRESHOLD = 2000;
      resetSilenceTimer();
    }
  };

  newRecognition.onresult = async (event) => {
    SILENCE_THRESHOLD = newRecognition.continuous ? 10000: 3000;
    if (interimTranscript.trim().length > 0) { resetSilenceTimer(); }
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

    if (hasFinalResult && finalTranscript.trim().length > 0) {
      let sendTranslationRequestText = finalTranscript.replace(/[、。？\s]+/g, ' ').trim();
      if (isRayModeActive()) { sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, newRecognition.lang); }

      if (isDebugEnabled()) console.info('[INFO] [SpeechRecognition] 發送翻譯請求文字:', sendTranslationRequestText);
      sendTranslationRequest(sendTranslationRequestText, previousText, newRecognition.lang);
      previousText = sendTranslationRequestText;
    }

    const fullTextRaw = `${finalTranscript} ${interimTranscript}`.replace(/[、。？\s]+/g, ' ').trim();
    let processedText = isRayModeActive() ? processRayModeTranscript(fullTextRaw, newRecognition.lang) : fullTextRaw;

    if (!hasFinalResult && processedText.trim() !== '') { processedText = wrapWithNoteByAlignment(processedText, 'webspeech'); }
    if (processedText.trim() !== '') { updateSourceText(processedText); }
  };

  newRecognition.onnomatch = () => { if (isDebugEnabled()) console.warn('[WARN] [SpeechRecognition] 無匹配辨識結果'); };
  newRecognition.onend = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (isDebugEnabled()) console.debug('[DEBUG] [SpeechRecognition] onend事件觸發');
    
    finalTranscript = '';
    interimTranscript = '';
    autoRestartRecognition();
  }
  newRecognition.onerror = (event) => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (event.error !== 'aborted') if (isDebugEnabled()) console.error('[ERROR] [SpeechRecognition] 辨識錯誤:', event.error);
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

/** 在 Ray Mode 時發送翻譯會經過這邊先替換語句 */
function processRayModeTranscript(text, sourceLang) {
  if (!text || !text.trim() || ['っ', 'っ。', '。', '？'].includes(text.trim())) return '';
  const pack = cachedRules.get(sourceLang);
  if (!pack || !pack.master) return text;

  const { rules, master } = pack;

  try {
    return text.replace(master, (match) => {
      const hit = rules.find(r => r.exact.test(match));
      return hit ? hit.target : match;
    });
  } catch (e) {
    let result = text;
    return result;
  }
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
        const deepgramStarted = await startDeepgram(sourceLang, (text, isFinal, shouldTranslate) => {
          handleDeepgramTranscript(text, isFinal, shouldTranslate, sourceLang);
        });
        if (deepgramStarted) {
          setRecognitionControlsState(true);
          isRecognitionActive = true;
          return;
        }
      } catch (err) {
        if (isDebugEnabled()) console.error('[ERROR] [SpeechRecognition] Deepgram 啟動失敗:', err);
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

  showMicInfoOnce().catch(() => { });

  window.addEventListener('beforeunload', () => {
    if (isDeepgramActive()) stopDeepgram();
  });
});

// #endregion

export { keywordRules, setRecognitionControlsState, clearAllTextElements };