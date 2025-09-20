import { loadLanguageConfig, getChunkSize, getTargetCodeById } from './config.js';
import { sendTranslationRequest } from './translationController.js';
import { preloadTranslationModels } from './translatorApiService.js';

// 語音辨識控制器
let recognition = null;

// 追蹤語音辨識狀態
let isRestartPending = false;
let restartAttempts = 0;
let lastResultTime = 0;
let watchdogInterval = null;
const WATCHDOG_TIMEOUT = 5000; // 看門狗逾時閾值（毫秒）
const WATCHDOG_CHECK_INTERVAL = 2000; // 檢查間隔（毫秒）

// 文字發送字幕使用的相關狀態
let isPaused = false;
let pauseTimeout = null;
let isRecognitionActive = false;

// 因為各種原因重新啟動語音擷取時的時間
const MAX_RESTART_ATTEMPTS = 50;
const RESTART_DELAY = 150;

// 關鍵字規則表
let keywordRules = [];
const cachedRules = new Map();

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

// 文字發送字幕使用、暫停語音辨識指定時間（毫秒）
function pauseRecognition(duration) {
  if (!recognition) {
    console.error('[ERROR] [SpeechRecognition] 語音辨識物件未初始化');
    return;
  }

  if (!isRecognitionActive) {
    console.debug('[DEBUG] [SpeechRecognition] 語音辨識未啟動，忽略暫停請求');
    return;
  }
  
  isPaused = true;
  recognition.stop();
  clearWatchdogInterval();
  console.info('[INFO] [SpeechRecognition] 語音辨識已暫停，持續時間:', duration);
  
  if (pauseTimeout) {
    clearTimeout(pauseTimeout);
  }

  pauseTimeout = setTimeout(() => {
      isPaused = false;
      if (isRecognitionActive && !document.getElementById('stop-recording').disabled) {
        try {
          recognition.start();
          lastResultTime = Date.now();
          startWatchdog();
          console.info('[INFO] [SpeechRecognition] 語音辨識恢復');
        } catch (error) {
          console.error('[ERROR] [SpeechRecognition] 恢復語音辨識失敗:', error);
          autoRestartRecognition();
        }
      } else {
        console.debug('[DEBUG] [SpeechRecognition] 未恢復語音辨識，因為語音辨識未啟動或已手動停止');
      }
    }, duration);
}

// 專為RayMode生成關鍵字過濾規則
function generateRayModeRules(sourceLang) {
  return cachedRules.get(sourceLang) || [];
}

// 專為RayMode過濾文字，僅移除標點符號並應用關鍵字替換
function filterRayModeText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
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
function recognitionBrowser() {
  const userAgent = navigator.userAgent || '';
  let browser = 'Unknown';
  let supportsTranslatorAPI = false;

  if (userAgent.includes('Edg/')) {
    browser = 'Edge';
  } else if (userAgent.includes('Chrome/')) {
    browser = 'Chrome';
    supportsTranslatorAPI = 'Translator' in self;
  } else {
    console.warn('[WARN] [SpeechRecognition] 未檢測到 Chrome 或 Edge 瀏覽器:', userAgent);
  }

  console.debug('[DEBUG] [SpeechRecognition] 瀏覽器檢測:', { browser, supportsTranslatorAPI, userAgent });
  return { browser, supportsTranslatorAPI };
}

// 更新原始文字到 DOM
function updateSourceText(text) {
  const sourceText = document.getElementById('source-text');
  if (sourceText && text.trim().length !== 0 && sourceText.textContent !== text) {
    requestAnimationFrame(() => {
      sourceText.textContent = text;
      sourceText.dataset.stroke = text;
      //sourceText.style.display = 'inline-block';
      //sourceText.offsetHeight;
      //sourceText.style.display = '';
    });
  }
}

// 監聽 local-translation-api 狀態變化
function monitorLocalTranslationAPI() {
  const localTranslationButton = document.getElementById('local-translation-api');
  if (!localTranslationButton) {
    console.debug('[DEBUG] [SpeechRecognition] 未找到 local-translation-api 元素');
    return;
  }

  const checkAndPreload = () => {
    const sourceLang = document.getElementById('source-language')?.value || 'ja-JP';
    const targetLangs = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none').map(lang => getTargetCodeById(lang));

    if (localTranslationButton.classList.contains('active') && targetLangs.length > 0) {
      console.debug('[DEBUG] [SpeechRecognition] 檢測到 local-translation-api 啟用，開始預下載模型:', { sourceLang, targetLangs });
      preloadTranslationModels(sourceLang, targetLangs, updateSourceText);
    } else {
      console.debug('[DEBUG] [SpeechRecognition] local-translation-api 未啟用或無目標語言');
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

// 清除看門狗 interval
function clearWatchdogInterval() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    console.debug('[DEBUG] [SpeechRecognition] 清除看門狗 interval');
  }
}

// 啟動看門狗檢查，暫時先不使用。
function startWatchdog() {
  return;
  const { browser } = recognitionBrowser();
  if (browser !== 'Chrome') {
    console.debug('[DEBUG] [SpeechRecognition] Edge 環境不啟動看門狗');
    return;
  }

  if (!recognition) {
    console.debug('[DEBUG] [SpeechRecognition] 未啟動看門狗，因 recognition 未初始化');
    return;
  }
  clearWatchdogInterval();
  watchdogInterval = setInterval(() => {
    if (isRecognitionActive && !isRestartPending && Date.now() - lastResultTime > WATCHDOG_TIMEOUT) {
      console.warn('[WARN] [SpeechRecognition] 看門狗偵測到臨時結果逾時，強制重啟', {
        timeSinceLastResult: Date.now() - lastResultTime,
        WATCHDOG_TIMEOUT
      });
      autoRestartRecognition(true);
    }
  }, WATCHDOG_CHECK_INTERVAL);
  console.debug('[DEBUG] [SpeechRecognition] 啟動看門狗檢查，間隔:', WATCHDOG_CHECK_INTERVAL);
}

// 初始化 SpeechRecognition 物件
function initializeSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援 SpeechRecognition');
    return null;
  }

  const newRecognition = new SpeechRecognition();
  const { browser } = recognitionBrowser();

  newRecognition.lang = document.getElementById('source-language')?.value || 'ja-JP';
  newRecognition.interimResults = true;
  newRecognition.continuous = browser === 'Edge';
  newRecognition.maxAlternatives = 1;

  let finalTranscript = '';
  let interimTranscript = '';

  newRecognition.onresult = (event) => {
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
      }
    }

    const rayModeButton = document.getElementById('raymode');
    const isRayModeActive = rayModeButton?.classList.contains('active') || false;
    const isLocalTranslationActive = document.getElementById('local-translation-api')?.classList.contains('active') || false;

    if (hasFinalResult) {
      console.info('[INFO] [SpeechRecognition] 最終結果:', finalTranscript.trim(), '字數', finalTranscript.trim().length);
      const sourceLang = document.getElementById("source-language")?.value || "ja-JP";
      let sendTranslationRequestText = finalTranscript.trim();

      if (isRayModeActive) {
        sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, sourceLang);
      }
      if (isLocalTranslationActive && browser === 'Chrome' && sourceLang === 'ja-JP') {
        sendTranslationRequestText = sendTranslationRequestText.replace(/\s/g, "");
        console.debug('[DEBUG] [SpeechRecognition] 標點符號整理結果:', sendTranslationRequestText, '字數', sendTranslationRequestText.length);
      }

      sendTranslationRequest(sendTranslationRequestText, newRecognition.lang, { browser, supportsTranslatorAPI: 'Translator' in self }, isLocalTranslationActive);
    }

    const fullText = finalTranscript + interimTranscript;
    const textToUpdate = isRayModeActive ?
      (hasFinalResult ? processText(fullText) : formatAlignedText(processText(fullText))) :
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
    clearWatchdogInterval();
    autoRestartRecognition();
  };

  newRecognition.onerror = (event) => {
    console.error('[ERROR] [SpeechRecognition] 錯誤:', event.error);
    console.warn('[WARN] [SpeechRecognition]，嘗試重新啟動');
    clearWatchdogInterval();
    autoRestartRecognition();
  };

  return newRecognition;
}

// 自動重啟語音辨識
function autoRestartRecognition(shouldRestart = true) {
  if (!shouldRestart || isPaused || !isRecognitionActive || document.getElementById('stop-recording').disabled || restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.debug('[DEBUG] [SpeechRecognition] 自動重啟取消:', {
      shouldRestart,
      isPaused,
      isRecognitionActive,
      stopButtonDisabled: document.getElementById('stop-recording').disabled,
      restartAttempts
    });

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      const sourceText = document.getElementById('source-text');
      sourceText.textContent = 'Failed to restart speech recognition. Please check your network or microphone.';
      sourceText.dataset.stroke = sourceText.textContent;
      document.getElementById('start-recording').disabled = false;
      document.getElementById('stop-recording').disabled = true;
    }
    return;
  }

  if (recognition) {
    console.debug('[DEBUG] [SpeechRecognition] 正在停止語音辨識');
    recognition.stop();
    isRestartPending = true;
  }

  recognition = initializeSpeechRecognition();
  if (!recognition) {
    console.error('[ERROR] [SpeechRecognition] 無法初始化新的 SpeechRecognition 物件');
    restartAttempts++;
    setTimeout(() => autoRestartRecognition(), RESTART_DELAY);
    return;
  }

  setTimeout(() => {
    if (isRestartPending && !isPaused && isRecognitionActive) {
      console.debug('[DEBUG] [SpeechRecognition] 準備自動重啟語音辨識');
      try {
        recognition.start();
        isRestartPending = false;
        restartAttempts = 0;
        lastResultTime = Date.now();
        startWatchdog();
        console.info('[INFO] [SpeechRecognition] 自動重啟語音辨識成功');
      } catch (error) {
        console.error('[ERROR] [SpeechRecognition] 自動重啟失敗:', error);
        restartAttempts++;
        setTimeout(() => autoRestartRecognition(), RESTART_DELAY);
      }
    }
  }, RESTART_DELAY);
}

// 專為乙夏れい配信客製化的模式（れいーモード）
function processText(text) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.info("[INFO] [SpeechRecognition] 跳過無效文字：", { original: text });
    return '';
  }

  const sourceLang = document.getElementById("source-language")?.value || "ja-JP";
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
  requestAnimationFrame(() => {
    [document.getElementById('source-text'), 
     document.getElementById('target-text-1'), 
     document.getElementById('target-text-2'), 
     document.getElementById('target-text-3')].forEach(element => {
      element.textContent = '';
      element.dataset.stroke = '';
      element.style.display = 'inline-block';
      element.offsetHeight;
      element.style.display = '';
    });
  });
}

function executeSpeechRecognition() {
  const { browser, supportsTranslatorAPI } = recognitionBrowser();

  if (!window.SpeechRecognition && !window.webkitSpeechRecognition || browser === 'Unknown') {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援');
    alert('Your browser is not supported. Please use Chrome or Edge browser.');
    return;
  }

  recognition = initializeSpeechRecognition();
  if (!recognition) {
    console.error('[ERROR] [SpeechRecognition] 無法初始化 SpeechRecognition');
    return;
  }

  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');

  const sourceText = document.getElementById('source-text');
  const targetText1 = document.getElementById('target-text-1');
  const targetText2 = document.getElementById('target-text-2');
  const targetText3 = document.getElementById('target-text-3');

  if (!startButton || !stopButton || !sourceText || !targetText1 || !targetText2 || !targetText3) {
    console.error('[ERROR] [SpeechRecognition] 必要元素未找到');
    return;
  }

  let stopButtonClicked = false;

  startButton.addEventListener('click', () => {
    recognition = initializeSpeechRecognition();
    if (!recognition) {
      console.error('[ERROR] [SpeechRecognition] 無法初始化 SpeechRecognition');
      alert('無法啟動語音辨識，請檢查瀏覽器支援或麥克風設定。');
      return;
    }

    clearAllTextElements();

    const miniStartButton = document.getElementById('mini-start-recording');
    miniStartButton.disabled = true;

    const miniStopButton = document.getElementById('mini-stop-recording');
    miniStopButton.disabled = false;

    const sourceLanguageSelect = document.getElementById('source-language');
    const selectedLang = sourceLanguageSelect.value;
    recognition.lang = selectedLang;
    console.info(`[INFO] [SpeechRecognition] 語音辨識語言更新為: ${recognition.lang}`);
    startButton.disabled = true;
    stopButton.disabled = false;
    stopButtonClicked = false;
    isRecognitionActive = true;

    try {
      recognition.start();
      lastResultTime = Date.now();
      startWatchdog();
      console.info('[INFO] [SpeechRecognition] 瀏覽器類型:', browser);
      console.info('[INFO] [SpeechRecognition] 開始語音辨識 - recognition 狀態:', recognition);
    } catch (error) {
      console.error('[ERROR] [SpeechRecognition] 啟動語音辨識失敗:', error);
      startButton.disabled = false;
      stopButton.disabled = true;
      isRecognitionActive = false;
      clearWatchdogInterval();
    }
  });

  stopButton.addEventListener('click', () => {
    const miniStartButton = document.getElementById('mini-start-recording');
    miniStartButton.disabled = false;

    const miniStopButton = document.getElementById('mini-stop-recording');
    miniStopButton.disabled = true;

    startButton.disabled = false;
    stopButton.disabled = true;
    stopButtonClicked = true;
    isRecognitionActive = false;
    if (recognition) {
      recognition.stop();
      clearWatchdogInterval();
      console.info('[INFO] [SpeechRecognition] 停止語音辨識 - recognition 狀態:', recognition);
    }
  });
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadLanguageConfig();
  loadKeywordRules();
  executeSpeechRecognition();
  monitorLocalTranslationAPI();
});

export { keywordRules, generateRayModeRules, updateSourceText, sendTranslationRequest, pauseRecognition };