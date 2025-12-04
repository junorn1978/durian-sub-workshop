// speechCapture.js
import { getChunkSize, isRayModeActive, isForceSingleLine } from './config.js';
import { sendTranslationRequest, updateStatusDisplay } from './translationController.js';

// 檢測瀏覽器類型
export const browserInfo = detectBrowser();

// 檢測目前使用的麥克風種類
let hasShownMicInfo = false;

// 語音辨識控制器
let recognition = null;

// 追蹤語音辨識狀態
let isRecognitionActive = false;

// 關鍵字規則表
let keywordRules = [];
const cachedRules = new Map();

// 短語設定表
let phrasesConfig = {};
const cachedPhrases = new Map();

// 檢測麥克風使用的相關函式
async function showMicInfoOnce() {
  if (hasShownMicInfo) return;
  hasShownMicInfo = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    console.warn('[WARN] [MicInfo] 此瀏覽器不支援 mediaDevices.enumerateDevices()');
    return;
  }

  let tempStream = null;
  try {
    // 先嘗試取得一次麥克風權限，否則裝置名稱可能是空字串
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      console.warn('[WARN] [MicInfo] 取得麥克風權限失敗（名稱可能會顯示為空）:', err);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const micInfoEl = document.getElementById('default-mic');
    const otherMicEl = document.getElementById('other-mic');
    if (!audioInputs.length) {
      const msg = '利用可能な音声入力デバイスが見つかりません。マイクが正しく接続されているか、システムの設定をご確認ください。';
      console.info('[INFO] [MicInfo]', msg);
      if (micInfoEl) micInfoEl.textContent = msg;
      return;
    }

    // Chromium 系列通常會有一個 deviceId === "default" 的裝置
    const defaultDevice = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0];

    let infoText = `現在ブラウザが使用しているマイク：

- ${defaultDevice.label || '名前を取得できません（マイクへのアクセス許可をご確認ください）'}

(※ 音声認識では通常この既定のマイクが使用されます。)`;
    let otherMic = 'その他の利用可能な音声入力デバイス：\n'; 
    if (audioInputs.length > 1) {
      audioInputs
        .filter(d => d !== defaultDevice)
        .forEach((d, idx) => {
          otherMic += `\n${idx + 1}. ${d.label || d.deviceId}`;
        });
    }

    console.info('[INFO] [MicInfo] 偵測到的音訊輸入裝置：', audioInputs);
    if (micInfoEl) micInfoEl.textContent = infoText;
    if (otherMicEl) otherMicEl.textContent = otherMic;
  } catch (err) {
    console.error('[ERROR] [MicInfo] 取得麥克風資訊失敗:', err);
  } finally {
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
  }
}

// 啟動語音按鍵的相關函式
function setRecognitionControlsState(isStarting) {
  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');

  if (isStarting) {
    startButton.disabled = true;
    stopButton.disabled = false;
    console.debug('[DEBUG] [SpeechRecognition] ', '按鈕切換至啟動狀態');
  } else {
    startButton.disabled = false;
    stopButton.disabled = true;
    console.debug('[DEBUG] [SpeechRecognition] ', '按鈕切換至停止狀態');
  }
}

// 語音擷取物件使用的相關參數
async function configureRecognition(recognition) {
  const sourceLanguage = document.getElementById('source-language')?.value;
  if (!sourceLanguage) {
    updateStatusDisplay('音声認識を始める前に、音声認識言語を選択してください。');
    setRecognitionControlsState(false); // 按鈕切換至停止狀態
    isRecognitionActive = false;
    throw new Error('[ERROR] [SpeechRecognition] 未選擇來源語言');
  }

  // 決定 processLocally 狀態
  const processLocallyStatus = await decideProcessLocally(sourceLanguage);

  /*
   * 目前recognition.processLocally參數在本地語音辨識模型已經下載的狀態下不管布林值是哪一個都是優先使用本地語音辨識模型
   * 目前只能在processLocally設置成true的時候phrases參數才會生效
   * 等候Chrome未來版本修正這個問題
   */
  
  /*
   * 設定語音辨識參數
   * zh-TW使用Chrome的語音讀取效果很差，目前還沒想到要使用甚麼方式來處理，所以先擺著等以後想到有甚麼方式再說
   * 使用zh-CN會比較好一些，但辨識率還是錯誤很大
   */
  if (browserInfo.isChrome) { recognition.processLocally = processLocallyStatus; }
  recognition.interimResults = true;
  recognition.lang = (sourceLanguage === 'zh-HK' ? 'yue' : sourceLanguage); //香港使用粵語語音
  recognition.continuous = processLocallyStatus;
  recognition.maxAlternatives = 1;

  // 短語設定，僅Chrome和語音模型本地端可用時套用。
  if (browserInfo.isChrome && recognition.processLocally && 'phrases' in recognition) {
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
    console.warn('[DEBUG] [SpeechRecognition] 本地處理不可用或 API 不支援，跳過 phrases 設定:', { lang: sourceLanguage, processLocally: processLocallyStatus });
  }

    console.debug('[DEBUG] [SpeechRecognition] 配置完成:', {
    interimResults: recognition.interimResults,
    lang: recognition.lang,
    continuous: recognition.continuous,
    maxAlternatives: recognition.maxAlternatives,
    processLocally: recognition.processLocally
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

  let result = text.replace(/[、。？,.]/g, ' ');
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
  if (!browserInfo.isChrome) return true;

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
function setupSpeechRecognition() {
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

        if (hasFinalResult) {
      console.info('[INFO] [SpeechRecognition] 最終結果:', finalTranscript.trim(), '字數', finalTranscript.trim().length);
      let sendTranslationRequestText = finalTranscript.trim();

      if (isRayModeActive()) {
        sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, newRecognition.lang);
      }

      // 發送翻譯請求
      sendTranslationRequest(sendTranslationRequestText, newRecognition.lang);
    }

    // 取得完整的原始辨識文字
    const fullTextRaw = finalTranscript + interimTranscript;

    // 1. 處理 Ray Mode (過濾)
    // 優先過濾掉不需要的字，這樣後續的截斷計算才會準確
    let processedText = isRayModeActive() 
        ? processRayModeTranscript(fullTextRaw, newRecognition.lang) 
        : fullTextRaw;

    // 2. 處理強制單行 (截斷)
    // 如果過濾後的文字依然太長，則進行截斷
    //if (isForceSingleLine()) {
    //    processedText = applySingleLineLimit(processedText, newRecognition.lang);
    //}

    // 3. 處理音符裝飾 (Decoration)
    // 只有在 interim (非最終) 階段才加音符，且要在截斷後加，確保音符不被切掉
    if (!hasFinalResult) {
        processedText = wrapWithNoteByAlignment(processedText);
    }

    updateSourceText(processedText);
  };

  // 這個事件目前只有在Edge有看到出現，Chrome從來沒出現過。
  newRecognition.onnomatch = (event) => {
    console.warn('[WARN] [SpeechRecognition] 無語音匹配結果', {
      finalTranscript: finalTranscript,
      interimTranscript: interimTranscript
    });
  };

  newRecognition.onend = () => {
    console.debug('[DEBUG] [SpeechRecognition] 產生onend事件 最終文字字數: ', finalTranscript.trim().length);
    autoRestartRecognition();
  };

  newRecognition.onerror = (event) => {
    if (event.error === 'aborted') {
      console.info('[INFO] [SpeechRecognition] 已中止語音辨識:', event.error);
    } else {
      console.error('[ERROR] [SpeechRecognition] 錯誤:', event.error);
    }
  };

  return newRecognition;
}

// 自動重啟語音辨識
async function autoRestartRecognition(options = { delay: 0 }) {
  if (!isRecognitionActive) {
    console.debug('[DEBUG] [SpeechRecognition] 自動重啟取消:', {
      isRecognitionActive,
      stopButtonDisabled: document.getElementById('stop-recording').disabled,
      currentDelay: options.delay
    });
    return;
  }

  setTimeout(async () => {
    console.debug('[DEBUG] [SpeechRecognition] 準備自動重啟語音辨識');
    try {
      recognition.start();
      options.delay = 0;  // 重置延遲值
      console.info('[INFO] [SpeechRecognition] 自動重啟語音辨識成功', { recognition });
    } catch (error) {
      console.error('[ERROR] [SpeechRecognition] 自動重啟失敗，嘗試重啟。 原因: ', error);
      if (options.delay < 1000) { options.delay += 200; } // 累積延遲值（物件屬性可直接修改）
      setTimeout(() => autoRestartRecognition(options), options.delay);  // 遞迴傳遞物件
    }
  }, options.delay);
}

// 專為乙夏れい配信客製化的模式（れいーモード）
function processRayModeTranscript(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ'  || text.trim() === 'っ。') {
    console.info("[INFO] [SpeechRecognition] 跳過無效文字：", { original: text });
    return '';
  }

  let result = text.replace(/[、。？,.]/g, ' ');

  const rules = generateRayModeRules(sourceLang);
  rules.forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });

  return result;
}

// 利用音符符號識別翻譯發送訊號
function wrapWithNoteByAlignment(baseText) {
  const alignment = document.querySelector('input[name="alignment"]:checked')?.value || 'left';

  return alignment === 'center' ? `🎼️${baseText}🎼` :
         alignment === 'right'  ? `🎼${baseText}` :
                                  `${baseText}🎼`;
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

function setupSpeechRecognitionHandlers() {
  if (!window.SpeechRecognition || browserInfo.browser === 'Unknown') {
    console.error('[ERROR] [SpeechRecognition] 瀏覽器不支援');
    alert('Your browser is not supported. Please use Chrome or Edge browser.');
    return;
  }

  recognition = setupSpeechRecognition();
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

  startButton.addEventListener('click', async () => {
    updateStatusDisplay(''); // 清空狀態顯示

    if (!recognition) {
      console.error('[ERROR] [SpeechRecognition] 無法初始化 SpeechRecognition');
      alert('音声認識を開始できませんでした。ブラウザの対応状況またはマイクの設定を確認してください。');
      return;
    }

    clearAllTextElements(); // 清空所有文字顯示元素

    setRecognitionControlsState(true);  // 按鈕切換至啟動狀態
    isRecognitionActive = true;

    // 設定語音物件參數
    await configureRecognition(recognition);

    try {
      recognition.start();
      console.info('[INFO] [SpeechRecognition] 瀏覽器類型:', browserInfo.browser);
      console.info('[INFO] [SpeechRecognition] 開始語音辨識 - recognition 狀態:', recognition);
    } catch (error) {
      console.error('[ERROR] [SpeechRecognition] 啟動語音辨識失敗:', error, recognition);
      setRecognitionControlsState(false); // 按鈕切換至停止狀態
      isRecognitionActive = false;
    }
  });

  stopButton.addEventListener('click', () => {
    setRecognitionControlsState(false); // 按鈕切換至停止狀態
    isRecognitionActive = false;
    if (recognition) {
      recognition.abort();
      clearAllTextElements(); // 清空所有文字顯示元素
      console.info('[INFO] [SpeechRecognition] 停止語音辨識 - recognition 狀態:', recognition);
    }
  });
}

// 在 DOM 載入完成後初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadKeywordRules();
  await loadPhrasesConfig();
  setupSpeechRecognitionHandlers();
  setRecognitionControlsState(false);
  isRecognitionActive = false;

  showMicInfoOnce().catch(err => {
    console.warn('[WARN] [MicInfo] 顯示麥克風資訊時發生錯誤:', err);
  });

});

export { keywordRules };