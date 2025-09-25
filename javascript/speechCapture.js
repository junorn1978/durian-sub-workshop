// speechCapture.js
import { loadLanguageConfig, getChunkSize, getTargetCodeById } from './config.js';
import { sendTranslationRequest } from './translationController.js';
import { addJapanesePunctuation, ensureTokenizerReady } from './punctuation-ja.js';

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
const MAX_RESTART_ATTEMPTS = 50;
const RESTART_DELAY = 150;

// 關鍵字規則表
let keywordRules = [];
const cachedRules = new Map();

// ---- Browser Detection and Recognition Config ----
function isEdge() {
  // 優先用新版 UA-CH
  const b = navigator.userAgentData?.brands || [];
  if (b.some(x => /Microsoft Edge/i.test(x.brand))) return true;
  // 後援：傳統 UA
  return /Edg\//.test(navigator.userAgent); // 注意：Edge 是 "Edg/"
}

function decideContinuous(procLocal) {
  if (isEdge()) {
    console.debug('[DEBUG] [SpeechRecognition] Edge 瀏覽器，強制 continuous = true');
    return true;
  }
  console.debug('[DEBUG] [SpeechRecognition] 非 Edge，continuous =', !!procLocal);
  return !!procLocal;
}

function configureRecognition(recognition, { procLocal }) {
  recognition.interimResults = true;
  recognition.lang = document.getElementById('source-language')?.value || 'ja-JP';
  recognition.continuous = decideContinuous(procLocal);
  recognition.maxAlternatives = 1;
  console.debug('[DEBUG] [SpeechRecognition] 配置完成:', {
    interimResults: recognition.interimResults,
    lang: recognition.lang,
    continuous: recognition.continuous,
    maxAlternatives: recognition.maxAlternatives
  });
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

// 判斷是否為 Chrome 品牌
function isChromeBrand() {
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) || [];
  const edge = brands.some(b => /Edge|Microsoft\s?Edge/i.test(b)) || /Edg\//.test(navigator.userAgent);
  const chrome = !edge && (brands.some(b => /Google Chrome|Chromium/i.test(b)) || /Chrome\//.test(navigator.userAgent));
  return chrome;
}

// 超時包裝函式
async function withTimeout(promise, ms = 1500) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), ms))
  ]);
}

// 決定 processLocally 的值
async function decideProcessLocally(lang) {
  if (!isChromeBrand()) return false;

  // 實驗 API 防守
  if (!('SpeechRecognition' in window) || !SpeechRecognition.available) return false;

  try {
    const status = await withTimeout(
      SpeechRecognition.available({ langs: [lang], processLocally: true }),
      1500
    );
    return status === 'available';
  } catch (e) {
    console.debug('[DEBUG] [SpeechRecognition] 本地處理檢查失敗:', e);
    return false;
  }
}

// 更新原始文字到 DOM
function updateSourceText(text) {
  const el = document.getElementById('source-text');
  if (!el || !text || text.trim().length === 0) return;

  if (el.textContent === text) return;

  el.textContent = text;
  el.dataset.stroke = text;
  }

// 初始化 SpeechRecognition 物件
function initializeSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition;

  if (!SpeechRecognition && window.webkitSpeechRecognition) {
    console.error('[ERROR] [SpeechRecognition] 不支援舊版 webkitSpeechRecognition');
    alert('このブラウザは旧式の「webkitSpeechRecognition」のみ対応しており、利用できません。\nChrome または Microsoft Edge のバージョン 139 以降をご利用ください。');
    return null;
  }

  if (!SpeechRecognition) {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援SpeechRecognition');
    alert('お使いのブラウザは SpeechRecognition に対応していません。\nChrome または Microsoft Edge のバージョン 139 以降をご利用ください。');
    return null;
  }

  const newRecognition = new SpeechRecognition();
  const procLocal = document.getElementById('source-language')?.value || 'ja-JP';
  configureRecognition(newRecognition, { procLocal });

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
      const sourceLang = document.getElementById("source-language")?.value || "ja-JP";
      let sendTranslationRequestText = finalTranscript.trim();

      if (isRayModeActive) {
        sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, sourceLang);
      }
      
      if (isLocalTranslationActive && recognitionBrowser().browser === 'Chrome' && sourceLang === 'ja-JP') {
        const noSpaces = sendTranslationRequestText.replace(/\s/g, '');
        try {
          /* sendTranslationRequestText = noSpaces; */
          sendTranslationRequestText = await addJapanesePunctuation(noSpaces, {
          mode: 'aggressive',                 // 'safe' 或 'aggressive'
          enableLongRelativeComma: true, // 需要時再開
          // minEnumerateForComma: 3,
          });
        } catch {
          sendTranslationRequestText = noSpaces; // 失敗時保底
        }
        console.debug('[DEBUG] [SpeechRecognition] 標點符號整理結果:', sendTranslationRequestText, '字數', sendTranslationRequestText.length);
      }

      sendTranslationRequest(sendTranslationRequestText, newRecognition.lang, recognitionBrowser(), isLocalTranslationActive);
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
    autoRestartRecognition();
  };

  newRecognition.onerror = (event) => {
    console.error('[ERROR] [SpeechRecognition] 錯誤:', event.error);
    console.warn('[WARN] [SpeechRecognition]，嘗試重新啟動');
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

  setTimeout(() => {
    if (isRestartPending && !isPaused && isRecognitionActive) {
      console.debug('[DEBUG] [SpeechRecognition] 準備自動重啟語音辨識');
      try {
        recognition.start();
        isRestartPending = false;
        restartAttempts = 0;
        lastResultTime = Date.now();
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
  const { browser, supportsTranslatorAPI } = recognitionBrowser();

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

    // 預設雲端
    let procLocal = false;

    // 只在 Chrome 嘗試偵測；Edge 或失敗都保持 false
    try {
      procLocal = await decideProcessLocally(selectedLang);
    } catch { procLocal = false; }

    // 設定 options（守備：某些版本沒有 options）
    try {
      recognition.options = { langs: [selectedLang], processLocally: procLocal };
    } catch { /* no-op */ }

    configureRecognition(recognition, { procLocal });

    console.info('[INFO] [SpeechRecognition] 開始語音辨識 - processLocally=', procLocal);

    try {
      recognition.start();
      lastResultTime = Date.now();
      console.info('[INFO] [SpeechRecognition] 瀏覽器類型:', browser);
      console.info('[INFO] [SpeechRecognition] 開始語音辨識 - recognition 狀態:', recognition);
    } catch (error) {
      console.error('[ERROR] [SpeechRecognition] 啟動語音辨識失敗:', error);
      startButton.disabled = false;
      miniStartButton.disabled = false;
      stopButton.disabled = true;
      miniStopButton.disabled = true;
      isRecognitionActive = false;
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
      console.info('[INFO] [SpeechRecognition] 停止語音辨識 - recognition 狀態:', recognition);
    }
  });
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadLanguageConfig();
  loadKeywordRules();
  await ensureTokenizerReady({ dicPath: '/data/dict' }); //kuromoji相關
  executeSpeechRecognition();
});

export { keywordRules, generateRayModeRules, updateSourceText, sendTranslationRequest };