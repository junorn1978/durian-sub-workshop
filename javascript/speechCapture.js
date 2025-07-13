import { sendTranslationRequest } from './translationController.js';

// 語音辨識控制器
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();

// 追蹤語音辨識狀態
let isRestartPending = false;
let restartAttempts = 0;

// 因為各種原因重新啟動語音擷取時的時間
const MAX_RESTART_ATTEMPTS = 10;
const RESTART_DELAY = 300;

// 關鍵字規則表
let keywordRules = [];

// 初始化時載入關鍵字替換對應表
async function loadKeywordRules() {
  try {
    const response = await fetch('data/ray_mode_keywords.json');
    if (!response.ok) throw new Error('無法載入關鍵字規則');
    keywordRules = await response.json();
    console.info('[INFO] [TextProcessing] 關鍵字規則載入成功:');
  } catch (error) {
    console.error('[ERROR] [TextProcessing] 載入關鍵字規則失敗:', error);
  }
}

function initializeSpeechRecognition() {
  let browser = 'Unknown';
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Edg/')) {
    browser = 'Edge';
  } else if (userAgent.includes('Chrome/')) {
    browser = 'Chrome';
  }

  // 確認瀏覽器支援
  if (!SpeechRecognition || browser === 'Unknown') {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援');
    alert('Your browser is not supported. Please use Chrome or Edge browser.');
    return;
  }

  // 設置語音辨識參數
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');
  const sourceText = document.querySelector('.source-text');

  if (!startButton || !stopButton || !sourceText) {
    console.error('[ERROR] [SpeechRecognition] 必要元素未找到');
    return;
  }

  // 追蹤停止按鈕狀態
  let stopButtonClicked = false;

  // 自動重啟語音辨識
  function autoRestartRecognition(shouldRestart = true) {
    if (!shouldRestart || stopButtonClicked || restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.debug('[DEBUG] [SpeechRecognition] 自動重啟取消:', { shouldRestart, stopButtonClicked, restartAttempts });
      if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        sourceText.textContent = 'Failed to restart speech recognition. Please check your network or microphone.';
        sourceText.dataset.stroke = sourceText.textContent;
        startButton.disabled = false;
        stopButton.disabled = true;
      }
      return;
    }

    if (recognition) {
      console.debug('[DEBUG] [SpeechRecognition] 正在停止語音辨識');
      recognition.stop();
      isRestartPending = true;
    }

    setTimeout(() => {
      if (isRestartPending) {
        console.debug('[DEBUG] [SpeechRecognition] 準備自動重啟語音辨識');
        try {
          recognition.start();
          isRestartPending = false;
          restartAttempts = 0;
          console.info('[INFO] [SpeechRecognition] 自動重啟語音辨識成功');
        } catch (error) {
          restartAttempts++;
          console.error('[ERROR] [SpeechRecognition] 自動重啟失敗:', error);
          setTimeout(() => autoRestartRecognition(), RESTART_DELAY);
        }
      }
    }, RESTART_DELAY);
  }

  // 專為乙夏れい配信客製化的模式（れいーモード）
  const cachedRules = new Map();
  function processText(text) {
    if (!text || text.trim() === '' || text.trim() === 'っ') {
      console.info("[INFO] [SpeechRecognition] 跳過無效文字：", { original: text });
      return '';
    }
    const sourceLang = document.getElementById("source-language")?.value || "ja";
    const chunkSizeMap = { "ja": 40, "zh-TW": 30, "en": 100, "es": 100, "id": 100 };
    const chunkSize = chunkSizeMap[sourceLang] || 40;
    let result = text.replace(/[、。？,.]/g, '');
    if (!cachedRules.has(sourceLang)) {
      cachedRules.set(sourceLang, keywordRules
        .filter(rule => rule.lang === sourceLang)
        .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
    }
    cachedRules.get(sourceLang).forEach(rule => {
      result = result.replace(rule.source, rule.target);
    });
    if (result.length >= chunkSize) {
      let multiple = Math.floor(result.length / chunkSize);
      const charsToRemove = multiple * chunkSize;
      result = result.substring(charsToRemove);
    }
    return result;
  }

  // 更新原始文字到 DOM
  function updateSourceText(text) {
    if (!sourceText) {
      console.error('[ERROR] [SpeechRecognition] sourceText 元素未找到');
      return;
    }
    if (text.trim().length !== 0 && sourceText.textContent !== text) {
      requestAnimationFrame(() => {
        sourceText.textContent = text;
        sourceText.dataset.stroke = text;
        sourceText.style.display = 'inline-block';
        sourceText.offsetHeight;
        sourceText.style.display = '';
        //console.debug('[DEBUG] [SpeechRecognition] 更新 sourceText 內容:', text);
      });
    }
  }

  // 開始錄音按鈕
  startButton.addEventListener('click', () => {
    const sourceLanguageSelect = document.getElementById('source-language');
    const selectedLang = sourceLanguageSelect.value;
    recognition.lang = selectedLang;
    console.info(`[INFO] [SpeechRecognition] 語音辨識語言更新為: ${recognition.lang}`);
    startButton.disabled = true;
    stopButton.disabled = false;
    stopButtonClicked = false;
    recognition.start();
    console.info('[INFO] [SpeechRecognition] 瀏覽器類型:', browser);
    console.info('[INFO] [SpeechRecognition] 開始語音辨識 - recognition 狀態:', recognition);
  });

  // 停止錄音按鈕
  stopButton.addEventListener('click', () => {
    startButton.disabled = false;
    stopButton.disabled = true;
    stopButtonClicked = true;
    recognition.stop();
    console.info('[INFO] [SpeechRecognition] 停止語音辨識 - recognition 狀態:', recognition);
  });

  // 儲存最終結果
  let finalTranscript = '';

  // 語音辨識結果處理
  recognition.onresult = (event) => {
    let interimTranscript = '';
    finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      console.debug('[DEBUG] [SpeechRecognition] 擷取結果:', transcript, 'isFinal:', event.results[i].isFinal);
      if (event.results[i].isFinal) {
        finalTranscript += transcript + ' ';
        console.info('[INFO] [SpeechRecognition] 最終結果:', finalTranscript.trim(), '字數', finalTranscript.trim().length);
        sendTranslationRequest(finalTranscript.trim(), recognition.lang, browser);
        if (browser === 'Chrome' && finalTranscript.trim() !== '') {
          recognition.stop();
          autoRestartRecognition();
        }
      } else {
        interimTranscript += transcript;
      }
    }
    const fullText = finalTranscript + interimTranscript;
    const truncateMode = document.getElementById('text-truncate-mode').value;
    if (truncateMode === 'full') {
      updateSourceText(fullText);
    } else if (truncateMode === 'truncate') {
      updateSourceText(processText(fullText));
    }
  };

  // 辨識結束後的動作
  recognition.onend = () => {
    if (finalTranscript.trim()) {
        console.debug('[DEBUG] [SpeechRecognition] 產生onend事件', finalTranscript.trim(), finalTranscript.trim().length);
        // sendTranslationRequest(finalTranscript.trim(), recognition.lang, browser);
	}
    autoRestartRecognition();
  };

  // 錯誤處理
  recognition.onerror = (event) => {
    console.error('[ERROR] [SpeechRecognition] 錯誤:', event.error);
    console.warn('[WARN] [SpeechRecognition]，嘗試重新啟動');
    autoRestartRecognition();
  };
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', () => {
  loadKeywordRules();
  initializeSpeechRecognition();
});
