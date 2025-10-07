// speechCapture.js
import { loadLanguageConfig, getChunkSize } from './config.js';
import { sendTranslationRequest, updateStatusDisplay } from './translationController.js';

// 檢測瀏覽器類型
const browserInfo = detectBrowser();

// 語音辨識控制器
let recognition = null;

// 追蹤語音辨識狀態
let isRestartPending = false;
let restartAttempts = 0;
let lastResultTime = 0;

// 文字發送字幕使用的相關狀態。
let isPaused = false;
let isRecognitionActive = false;

// 因為各種原因重新啟動語音擷取時的時間
const MAX_RESTART_ATTEMPTS = 500000; //使用這數字是本來就不打算讓她超過次數停止，但AI會一直要求加入所以就提高數值避免AI一直修改
let RESTART_DELAY = 0;

// 關鍵字規則表
let keywordRules = [];
const cachedRules = new Map();

// 短語設定表
let phrasesConfig = {};
const cachedPhrases = new Map();

// 啟動語音按鍵的相關函式
function toggleStartStopButtons(isStarting) {
  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');
  const miniStartButton = document.getElementById('mini-start-recording');
  const miniStopButton = document.getElementById('mini-stop-recording');

  if (isStarting) {
    startButton.disabled = true;
    stopButton.disabled = false;
    miniStartButton.disabled = true;
    miniStopButton.disabled = false;
    console.debug('[DEBUG] [speechCapture.js]', '按鈕切換至啟動狀態');
  } else {
    startButton.disabled = false;
    stopButton.disabled = true;
    miniStartButton.disabled = false;
    miniStopButton.disabled = true;
    console.debug('[DEBUG] [speechCapture.js]', '按鈕切換至停止狀態');
  }
}

// 語音擷取物件使用的相關參數
async function configureRecognition(recognition) {
  const sourceLanguage = document.getElementById('source-language')?.value || 'ja-JP';
  const processLocallyStatus = await decideProcessLocally(sourceLanguage);

  // 設定語音辨識參數
  if (browserInfo.browser === 'chrome') { recognition.processLocally = processLocallyStatus; }
  recognition.interimResults = true;
  recognition.lang = (sourceLanguage === 'zh-HK' ? 'yue' : sourceLanguage); //香港使用粵語語音
  recognition.continuous = processLocallyStatus;
  recognition.maxAlternatives = 1;

  // 短語設定，僅本地可用時套用，暫不支援所以先註解，等有支援後在處理
  /*
  if (processLocallyStatus && 'phrases' in recognition) {
    const selectedPhrases = getPhrasesForLang(sourceLanguage);
    if (selectedPhrases.length > 0) {
      recognition.phrases = selectedPhrases;
      console.debug('[DEBUG] [SpeechRecognition] 已設定 phrases 參數:', { lang: sourceLanguage, count: selectedPhrases.length });
    } else {
      recognition.phrases = [];
      console.debug('[DEBUG] [SpeechRecognition] phrases 陣列為空，跳過設定:', { lang: sourceLanguage });
    }
  } else {
    recognition.phrases = [];  // 清空，避免殘留
    console.debug('[DEBUG] [SpeechRecognition] 本地處理不可用或 API 不支援，跳過 phrases 設定:', { lang: sourceLanguage, processLocally: processLocallyStatus });
  }

    console.debug('[DEBUG] [SpeechRecognition] 配置完成:', {
    interimResults: recognition.interimResults,
    lang: recognition.lang,
    continuous: recognition.continuous,
    maxAlternatives: recognition.maxAlternatives,
    processLocally: recognition.processLocally
  });
  */
}

// 初始化時載入關鍵字替換對應表
async function loadKeywordRules() {
  try {
    const response = await fetch('data/ray_mode_keywords.json');
    if (!response.ok) throw new Error('無法載入關鍵字規則');
    
    keywordRules = await response.json();
    console.info('[INFO] [TextProcessing] 關鍵字規則載入成功:');
    
    const uniqueLangs = [...new Set(keywordRules.map(rule => rule.lang))];
    uniqueLangs.forEach(lang => {
      cachedRules.set(lang, keywordRules
                 .filter(rule => rule.lang === lang)
                 .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
    });
  } catch (error) {
    console.error('[ERROR] [TextProcessing] 載入關鍵字規則失敗:', error);
  }
}

// 初始化時載入短語配置
async function loadPhrasesConfig() {
  try {
    const response = await fetch('data/phrases_config.json');
    if (!response.ok) throw new Error('無法載入 phrases 配置');
    
    phrasesConfig = await response.json();
    console.info('[INFO] [TextProcessing] phrases 配置載入成功');

    // 依語言快取 SpeechRecognitionPhrase 物件陣列
    Object.keys(phrasesConfig.languages || {}).forEach(lang => {
      const langData = phrasesConfig.languages[lang] || [];
      let phraseObjects = [];
      // 先判斷物件能不能用，因為Chrome 141標準版以前還不能使用這個參數
      if (typeof SpeechRecognitionPhrase !== 'undefined') {
        phraseObjects = langData.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost));
      } else {
        console.debug('[DEBUG] [TextProcessing] phrases 支援不可用，fallback 空陣列:', { lang });
      }
      cachedPhrases.set(lang, phraseObjects);
    });

    // 預設快取
    if (phrasesConfig.defaults) {
      let defaultObjects = [];
      if (typeof SpeechRecognitionPhrase !== 'undefined') {
        defaultObjects = phrasesConfig.defaults.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost));
      } else {
        console.debug('[DEBUG] [TextProcessing] 預設 phrases 支援不可用，fallback 空陣列');
      }
      cachedPhrases.set('default', defaultObjects);
    }
  } catch (error) {
    console.error('[ERROR] [TextProcessing] 載入 phrases 配置失敗:', error);
    phrasesConfig = { languages: {} };  // fallback 空配置
  }
}

// 輔助函式：依語言取出 phrases 物件陣列（在 loadPhrasesConfig() 之後插入）
function getPhrasesForLang(sourceLang) {
  return cachedPhrases.get(sourceLang) || cachedPhrases.get('default') || [];
}

// 專為RayMode生成關鍵字過濾規則
function generateRayModeRules(sourceLang) {
  return cachedRules.get(sourceLang) || [];
}

// 專為RayMode過濾文字，僅移除標點符號並應用關鍵字替換
function filterRayModeText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ'|| text.trim() === 'っ。') {
    console.info("[INFO] [SpeechRecognition] 跳過無效文字：", { original: text });
    return '';
  }
  
  let result = text.replace(/[、。？,.]/g, '');
  const rules = generateRayModeRules(sourceLang);
  rules.forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });
  
  return result;
}

// 判斷瀏覽器類型並檢查 Translator API 可用性
function detectBrowser() {
  const userAgent = navigator.userAgent || '';
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) || [];
  
  // 偵測 Edge
  const isEdge = brands.some(b => /Edge|Microsoft\s?Edge/i.test(b)) || /Edg\//.test(userAgent);
  
  // 偵測 Chrome（排除 Edge）
  const isChrome = !isEdge && (brands.some(b => /Google Chrome/i.test(b)) || /Chrome\//.test(userAgent));
  
  let browser = 'Unknown';
  let supportsTranslatorAPI = false;
  
  if (isEdge) {
    browser = 'Edge';
  } else if (isChrome) {
    browser = 'Chrome';
    supportsTranslatorAPI = 'Translator' in self;
  } else {
    console.warn('[WARN] [SpeechRecognition] 未檢測到 Chrome 或 Edge 瀏覽器:', userAgent);
  }
  
  console.debug('[DEBUG] [SpeechRecognition] 瀏覽器檢測:', { browser, isChrome, supportsTranslatorAPI, userAgent });
  return { browser, isChrome, supportsTranslatorAPI };
}

// 決定 processLocally 的值
async function decideProcessLocally(lang) {
  const { isChrome } = detectBrowser();
  if (!isChrome) return true;

  if (!('SpeechRecognition' in window) || !SpeechRecognition.available) return false;
  try {
    const status = await SpeechRecognition.available({ langs: [lang], processLocally: true });
    return status === 'available';
  } catch (e) {
    console.debug('[DEBUG] [SpeechRecognition] 本地處理檢查失敗:', e);
    return false;
  }
}

// 更新原始文字到 DOM
function updateSourceText(text) {
  const el = document.getElementById('source-text');
  if (!el || !text || text.trim().length === 0 || el.textContent === text) return;
  
  el.textContent = text;
  el.dataset.stroke = text;
}

// 初始化 SpeechRecognition 物件
function initializeSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition;

  if (!SpeechRecognition) {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援SpeechRecognition');
    alert('お使いのブラウザは SpeechRecognition に対応していません。\nChrome または Microsoft Edge のバージョン 139 以降をご利用ください。');
    return null;
  }
  const newRecognition = new SpeechRecognition();

  let finalTranscript = '';
  let interimTranscript = '';

    newRecognition.onresult = async (event) => {
    lastResultTime = Date.now();

    let hasFinalResult = false;
    interimTranscript = '';
    finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
        hasFinalResult = true;
      } else {
        interimTranscript += transcript;
        //console.debug('[DEBUG] [SpeechRecognition] 臨時結果:', interimTranscript, '字數', finalTranscript.trim().length);
      }
    }

    const rayModeButton = document.getElementById('raymode');
    const isRayModeActive = rayModeButton?.classList.contains('active') || false;
    const isLocalTranslationActive = document.getElementById('local-translation-api')?.classList.contains('active') || false;

    if (hasFinalResult) {
      console.info('[INFO] [SpeechRecognition] 最終結果:', finalTranscript.trim(), '字數', finalTranscript.trim().length);
      let sendTranslationRequestText = finalTranscript.trim();

      if (isRayModeActive) {
        sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, newRecognition.lang);
      }

      sendTranslationRequest(sendTranslationRequestText, newRecognition.lang, browserInfo, isLocalTranslationActive);
    }

    const fullText = finalTranscript + interimTranscript;
    const textToUpdate = isRayModeActive ?
      (hasFinalResult ? processText(fullText, newRecognition.lang) : formatAlignedText(processText(fullText, newRecognition.lang))) :
      (hasFinalResult ? fullText : formatAlignedText(fullText));
    updateSourceText(textToUpdate);
  };

  newRecognition.onnomatch = (event) => {
    console.warn('[WARN] [SpeechRecognition] 無語音匹配結果', {
      finalTranscript: finalTranscript,
      interimTranscript: interimTranscript
    });
    lastResultTime = Date.now();
  };

  newRecognition.onend = () => {
    console.debug('[DEBUG] [SpeechRecognition] 產生onend事件 最終文字字數: ', finalTranscript.trim().length);
    autoRestartRecognition();
  };

  newRecognition.onerror = (event) => {
    console.error('[ERROR] [SpeechRecognition] 錯誤:', event.error);
  };

  return newRecognition;
}

// 自動重啟語音辨識
async function autoRestartRecognition(shouldRestart = true) {
  if (!shouldRestart || isPaused || !isRecognitionActive || document.getElementById('stop-recording').disabled || restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.debug('[DEBUG] [speechCapture.js] 自動重啟取消:', {
      shouldRestart,
      isPaused,
      isRecognitionActive,
      stopButtonDisabled: document.getElementById('stop-recording').disabled,
      restartAttempts
    });

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      updateStatusDisplay('Failed to restart speech recognition. Please check your network or microphone.');
      toggleStartStopButtons(false); // 按鈕切換至停止狀態
      stopButtonClicked = true;
      isRecognitionActive = false;
    }
    return;
  }

  isRestartPending = true;

  setTimeout(async () => {
    if (isRestartPending && !isPaused && isRecognitionActive) {
      console.debug('[DEBUG] [speechCapture.js] 準備自動重啟語音辨識');
      try {
        //設定語音物件參數，可能用不到所以先註解，之後測試都沒問題的話就可以刪除。
        //await configureRecognition(recognition);

        recognition.start();
        isRestartPending = false;
        restartAttempts = 0;
        lastResultTime = Date.now();
        RESTART_DELAY = 0;
        console.info('[INFO] [speechCapture.js] 自動重啟語音辨識成功');
      } catch (error) {
        console.error('[ERROR] [speechCapture.js] 自動重啟失敗，嘗試重啟。重啟次數:', restartAttempts, error);
        if (RESTART_DELAY < 1000) { RESTART_DELAY += 200;}
        restartAttempts++;
        recognition.stop();
        setTimeout(() => autoRestartRecognition(), RESTART_DELAY);
      }
    }
  }, RESTART_DELAY);
}

// 專為乙夏れい配信客製化的模式（れいーモード）
function processText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ'  || text.trim() === 'っ。') {
    console.info("[INFO] [SpeechRecognition] 跳過無效文字：", { original: text });
    return '';
  }
  
  const chunkSize = getChunkSize(sourceLang) || 40;
  let result = text.replace(/[、。？,.]/g, '');
  
  const rules = generateRayModeRules(sourceLang);
  rules.forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });

  if (result.length >= chunkSize) {
    let multiple = Math.floor(result.length / chunkSize);
    const charsToRemove = multiple * chunkSize;
    result = result.substring(charsToRemove);
  }

  return result;
}

// 利用音符符號識別翻譯發送訊號
function formatAlignedText(baseText) {
  const alignment = document.querySelector('input[name="alignment"]:checked')?.value || 'left';
  if (alignment === 'center') return `🎼️${baseText}🎼`;
  if (alignment === 'right') return `🎼${baseText}`;
  return `${baseText}🎼`;
}

// 清空所有文字顯示元素
function clearAllTextElements() {
  const els = document.querySelectorAll('#source-text, #target-text-1, #target-text-2, #target-text-3');
  for (const el of els) {
    // 停止進行中的動畫
    try { el.getAnimations?.().forEach(a => a.cancel()); } catch {}

    // 清空文字與資料
    el.textContent = '';
    el.dataset.stroke = '';
  }
}

function executeSpeechRecognition() {
  const { browser, supportsTranslatorAPI } = detectBrowser();

  if (!window.SpeechRecognition || browser === 'Unknown') {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援');
    alert('Your browser is not supported. Please use Chrome or Edge browser.');
    return;
  }

  recognition = initializeSpeechRecognition();
  if (!recognition) {
    console.error('[ERROR] [SpeechRecognition] 無法初始化 SpeechRecognition');
    return;
  }

  //console.debug(`[DEBUG][SpeechRecognition] 語音物件: ${recognition}`);

 const [startButton, stopButton, sourceText, targetText1, targetText2, targetText3,] = [
       'start-recording', 'stop-recording', 'source-text', 'target-text-1', 'target-text-2', 'target-text-3',]
       .map(document.getElementById.bind(document));

  if (!startButton || !stopButton || !sourceText || !targetText1 || !targetText2 || !targetText3) {
    console.error('[ERROR] [SpeechRecognition] 必要元素未找到');
    return;
  }

  let stopButtonClicked = false;

  startButton.addEventListener('click', async () => {
    if (!recognition) {
      console.error('[ERROR] [SpeechRecognition] 無法初始化 SpeechRecognition');
      alert('無法啟動語音辨識，請檢查瀏覽器支援或麥克風設定。');
      return;
    }

    clearAllTextElements();

    toggleStartStopButtons(true);  // 按鈕切換至啟動狀態
    stopButtonClicked = false;
    isRecognitionActive = true;

    // 設定語音物件參數
    await configureRecognition(recognition);

    try {
      recognition.start();
      lastResultTime = Date.now();
      console.info('[INFO] [SpeechRecognition] 瀏覽器類型:', browser);
      console.info('[INFO] [SpeechRecognition] 開始語音辨識 - recognition 狀態:', recognition);
    } catch (error) {
      console.error('[ERROR] [SpeechRecognition] 啟動語音辨識失敗:', error);
      toggleStartStopButtons(false); // 按鈕切換至停止狀態
      isRecognitionActive = false;
    }
  });

  stopButton.addEventListener('click', () => {
    toggleStartStopButtons(false); // 按鈕切換至停止狀態
    stopButtonClicked = true;
    isRecognitionActive = false;
    if (recognition) {
      recognition.stop();
      console.info('[INFO] [SpeechRecognition] 停止語音辨識 - recognition 狀態:', recognition);
    }
  });
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadLanguageConfig();
  loadKeywordRules();
  // loadPhrasesConfig(); 暫時先不使用，因為不明原因會造成語音擷取顯示不支援語系
  executeSpeechRecognition();
});

export { keywordRules };