import { loadLanguageConfig, getChunkSize, getTargetCodeById } from './config.js';
import { sendTranslationRequest } from './translationController.js';

// 語音辨識控制器
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();

// 追蹤語音辨識狀態
let isRestartPending = false;
let restartAttempts = 0;

// 因為各種原因重新啟動語音擷取時的時間
const MAX_RESTART_ATTEMPTS = 50;
const RESTART_DELAY = 150;

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

// 判斷瀏覽器是edge還是chrome還是其他
// 使用邏輯不同所以只能先辨識
function recognitionBrowser() {
  const userAgent = navigator.userAgent || '';
  return userAgent.includes('Edg/') ? 'Edge' :
         userAgent.includes('Chrome/') ? 'Chrome' : 'Unknown';
}

// 專為RayMode生成關鍵字過濾規則
function generateRayModeRules(sourceLang) {
  const cachedRules = new Map();
  if (!cachedRules.has(sourceLang)) {
    cachedRules.set(sourceLang, keywordRules
      .filter(rule => rule.lang === sourceLang)
      .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
  }
  return cachedRules.get(sourceLang);
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

function executeSpeechRecognition() {

  const browser = recognitionBrowser();

  // 確認瀏覽器支援
  if (!SpeechRecognition || browser === 'Unknown') {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援');
    alert('Your browser is not supported. Please use Chrome or Edge browser.');
    return;
  }

  // 設置語音辨識參數
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = browser === 'Edge'; // 依照瀏覽器類型決定要true(edge)還是false(Chrome)
  recognition.maxAlternatives = 1;

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
  // 主要處理以下狀況
  // 1. 處理經常錯誤的語音辨識結果，以及盡量避免部分有心人士因為錯誤的機器翻譯而進行惡意攻擊
  // 2. 讓語音擷取結果盡可能保持在一行的程度，避免語音擷取結果過度占用版面
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

  // 這一段是利用音符符號來識別翻譯發送的訊號，當音符消失時，最終結果產生並發送翻譯請求
  function formatAlignedText(baseText) {
    const alignment = document.querySelector('input[name="alignment"]:checked')?.value || 'left';
    if (alignment === 'center') return `🎼️${baseText}🎼`;
    if (alignment === 'right') return `🎼${baseText}`;
    return `${baseText}🎼`; // 預設為 left
  }

  // 更新原始文字到 DOM
  // 這一段AI是建議這樣可能太過度更新DOM，會造成系統負擔
  // 但這邊實際測試的結果不這樣做的話反而會出現整個瀏覽器卡住的狀態，所以保持，之後有碰到問題在考慮要怎麼修改。
  function updateSourceText(text) {
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

  // 清空所有文字顯示元素
  // 這一段只有用在按下開始錄音的時候會將範例文字先清空而已，其他地方沒有使用到
  // 原本是想有沒有需要和上面的函式合併，但AI建議不要這樣做，所以就另外生成了
  function clearAllTextElements() {
    requestAnimationFrame(() => {
      [sourceText, targetText1, targetText2, targetText3].forEach(element => {
        element.textContent = '';
        element.dataset.stroke = '';
        element.style.display = 'inline-block';
        element.offsetHeight;
        element.style.display = '';
      });
    });
  }

  // 開始錄音按鈕
  startButton.addEventListener('click', () => {
    clearAllTextElements();

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

  let finalTranscript = '';
  let interimTranscript = '';

  // 語音辨識結果事件處理
  recognition.onresult = (event) => {
    let hasFinalResult = false;
    interimTranscript = '';
    finalTranscript = '';

    // 參考Chrome web speech api的demo網頁的寫法，大概...
    // 完全由瀏覽器的api來判斷什麼時候要產出結果並且發送翻譯.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      console.debug('[DEBUG] [SpeechRecognition] 擷取結果:', transcript, 'isFinal:', event.results[i].isFinal);
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
        hasFinalResult = true;
      } else {
        interimTranscript += transcript;
      }
    }

    // 判斷raymode有沒有開啟
    const rayModeButton = document.getElementById('raymode');
    const isRayModeActive = rayModeButton?.classList.contains('active') || false;
    
    // 旗標值最終結果產生時先發送翻譯
    if (hasFinalResult) {
      console.info('[INFO] [SpeechRecognition] 最終結果:', finalTranscript.trim(), '字數', finalTranscript.trim().length);
      const sourceLang = document.getElementById("source-language")?.value || "ja-JP";
      const sendTranslationRequestText = isRayModeActive ?
                                        filterRayModeText(finalTranscript.trim(), sourceLang) :
                                        finalTranscript.trim();
      sendTranslationRequest(sendTranslationRequestText, recognition.lang, browser);
    }

    // fullText 還沒有最終結果前由 interimTranscript 提供顯示文字
    //          最終結果產生後則由 finalTranscript 提供顯示文字
    const fullText = finalTranscript + interimTranscript;
    const textToUpdate = isRayModeActive ?                            // 是否在raymode
                         (hasFinalResult ? processText(fullText) :    // 在raymode並且是最終文字，使用raymode專用函式過濾文字
                         formatAlignedText(processText(fullText))) :  // 在raymode並且是臨時文字，使用加入邊緣字和raymode專用函式過濾文字
                         fullText;                                    // 不是在raymode下就直接顯示正常文字
    // 結果整理好後發送到UI
    updateSourceText(textToUpdate);
  };

  // 這個是沒有比對到最終結果但卻重新開始了onresult事件的事件(可能)
  // 這邊目前不清楚運作方式，先嘗試加入一些代碼看這邊產生事件的時候可能的狀況
  recognition.onnomatch = (event) => {
    console.warn('[WARN] [SpeechRecognition] 無語音匹配結果', {
      finalTranscript: finalTranscript,
      interimTranscript: interimTranscript
    });
  };

  // 辨識結束後的動作
  // 這邊Chrome是使用一次一句的方式擷取，所以會頻繁產生onend事件
  recognition.onend = () => {
    console.debug('[DEBUG] [SpeechRecognition] 產生onend事件 最終文字字數: ', finalTranscript.trim().length);
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
document.addEventListener('DOMContentLoaded', async () => {
  await loadLanguageConfig();
  loadKeywordRules();
  executeSpeechRecognition();
});

export { keywordRules, generateRayModeRules };