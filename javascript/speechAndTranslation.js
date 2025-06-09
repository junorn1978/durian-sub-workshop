const DEBUG = true;

function logInfo(...args) {
  if (DEBUG) {
    console.info(...args);
  }
}
document.addEventListener("DOMContentLoaded", () => {
  logInfo("[SpeechAndTranslation] 腳本已載入。");
  // ==========================================================================
  // 常量與配置
  // ==========================================================================
  const CONFIG = {
    MAX_RESTART_ATTEMPTS: 5, // 語音辨識最大重試次數，超過後停止重試
    TRANSLATION_TIMEOUT: 3000, // 翻譯請求超時時間（毫秒），超時後視為失敗並處理下一個回應
    MAX_PENDING_RESPONSES: 10, // 最大待處理翻譯回應數量，超過時移除最早的回應
    RESTART_DELAY: 500, // 語音辨識重啟前的延遲時間（毫秒），避免立即重試
    MIN_TEXT_LENGTH: 5, // 發送翻譯請求的最小文字長度，少於此長度則延遲發送
    TRANSLATION_PENDING_TIMEOUT: 2000, // 待翻譯文字的延遲發送時間（毫秒），等待累積足夠文字
    INTERIM_STAGNATION_TIMEOUT: 3000 // 臨時文字停滯超時時間（毫秒），若臨時文字未更新則觸發翻譯
  };
  
  const TEXT_REPLACEMENTS = {
    "リカちゃん": "(れいかちゃん)",
    "リコちゃん": "(れいかちゃん)",
    "れいこちゃん": "(れいかちゃん)",
    "***ょっと": "ちょっと",
    "処刑さん": "初見さん",
    "証券さん": "初見さん",
    "所見さん": "初見さん",
    "出勤さん": "初見さん",
    "スパちゃん": "(スパチャ)",
    "スバちゃん": "(スパチャ)",
    "麗華ちゃん": "れいかちゃん",
    "えっちゃん": "れいちゃん"
    // 可根據需要添加更多替換規則，例如：
    // "他の誤判文字": "正確文字"
  };
  
  const ELEMENT_IDS = {
    startSpeechButton: "start-recording",
    stopSpeechButton: "stop-recording",
    sourceLanguageSelect: "source-language",
    targetLanguage1Select: "target-language1",
    targetLanguage2Select: "target-language2",
    targetLanguage3Select: "target-language3",
    apiMode: "api-mode",
    serviceUrlInput: "api-key-input",
    apiKeyInput: "api-key-value"
  };
  
  const ERROR_MESSAGES = {
    "no-speech": {
      log: "音声が検出されませんでした。リスタートを試みます。"
    },
    "network": {
      log: "ネットワークエラーが発生しました。リスタートを試みます。"
    },
    "audio-capture": {
      log: "音声キャプチャに失敗しました。マイクを確認してください。"
    },
    "not-allowed": {
      log: "音声認識の許可が拒否されました。"
    },
    default: {
      log: "予期しないエラー: {error}"
    }
  };
  
  const MESSAGES = {
    missingElements: "必要なDOM要素が見つかりません: {ids}",
    browserNotSupported: "このブラウザは音声認識をサポートしていません。Chromeを使用してください。",
    speechAlreadyRunning: "音声認識はすでに実行中です。",
    speechNotRunning: "音声認識は実行中ではありません。",
    startFailed: "音声認識を開始できませんでした: {error}",
    invalidResults: "無効または空の音声認識結果が検出されました。"
  };
  // ==========================================================================
  // 狀態與文字
  // ==========================================================================
  const state = {
    finalText: "", // 儲存語音辨識的最終文字結果
    interimText: "", // 儲存語音辨識的臨時（即時）文字結果
    totalCharCount: 0, // 累計最終文字的字符數，用於控制是否清除下一次結果
    shouldClearNext: false, // 標記是否在下一次結果處理時清除最終文字
    isRecognitionRunning: false, // 標記語音辨識是否正在運行
    restartAttempts: 0, // 記錄語音辨識重試次數，用於限制最大重試次數
    startTime: null, // 記錄語音辨識開始的時間戳（毫秒），用於檢查運行時間
    lastNonEmptyText: "", // 儲存最後一次非空的顯示文字，用於後續處理
    currentSequenceNumber: 1, // 當前翻譯請求的序列號，遞增用於追蹤請求順序
    expectedSequenceNumber: 1, // 預期處理的翻譯回應序列號，確保按順序處理
    pendingResponses: {}, // 儲存待處理的翻譯回應，鍵為序列號，值為回應資料
    pendingTranslationText: "", // 儲存待發送的翻譯文字，等待達到最小長度或超時
    translationTimer: null, // 翻譯定時器，用於延遲發送翻譯請求
    isManuallyStopped: false, // 標記語音辨識是否由用戶手動停止
    lastStopWasManual: false, // 標記上一次停止是否為手動停止，用於後續邏輯判斷
    ignoreTranslations: false, // 標記是否忽略後續翻譯回應（例如手動停止後）
    lastInterimUpdateTime: null, // 記錄臨時文字最後更新的時間戳，用於檢查停滯
    lastSentInterimText: "", // 記錄最後發送的臨時文字，避免重複發送
    interimStagnationTimer: null, // 臨時文字停滯定時器，用於檢查臨時文字是否停滯並觸發翻譯
    displayBuffer: { // 儲存各目標語言的顯示緩衝區，控制文字顯示時間
      target1: {
        text: "",
        timestamp: 0,
        minDisplayTime: 2500
      }, // 第一目標語言的顯示文字、時間戳與最小顯示時間
      target2: {
        text: "",
        timestamp: 0,
        minDisplayTime: 2500
      }, // 第二目標語言的顯示文字、時間戳與最小顯示時間
      target3: {
        text: "",
        timestamp: 0,
        minDisplayTime: 2500
      } // 第三目標語言的顯示文字、時間戳與最小顯示時間
    }
  };
  const texts = {
    source: "",
    target1: "",
    target2: "",
    target3: ""
  };
  // ==========================================================================
  // 輔助函數
  // ==========================================================================
  function handleError(type, message, details = {}) {
    const errorConfig = ERROR_MESSAGES[type] || ERROR_MESSAGES.default;
    const logMessage = errorConfig.log.replace("{error}", message);
    console.error(`[SpeechAndTranslation] ${logMessage}`, details);
  }
  // 重置語音辨識和翻譯相關的 state 物件到初始值
  function resetState() {
    Object.assign(state, {
      finalText: "",
      interimText: "",
      totalCharCount: 0,
      shouldClearNext: false,
      isRecognitionRunning: false,
      restartAttempts: 0,
      startTime: null,
      lastNonEmptyText: "",
      currentSequenceNumber: 1,
      expectedSequenceNumber: 1,
      pendingResponses: {},
      pendingTranslationText: "",
      translationTimer: null,
      isManuallyStopped: false,
      lastStopWasManual: false,
      ignoreTranslations: false,
      lastInterimUpdateTime: null,
      lastSentInterimText: "",
      interimStagnationTimer: null
    });
    logInfo("[SpeechAndTranslation] 狀態已重置。");
  }

  function ensureRecognition() {
    if (!recognition) {
      handleError("browser", MESSAGES.browserNotSupported);
      return false;
    }
    return true;
  }

function checkInterimStagnation(sourceLang) {
  const now = Date.now();
  if (
    state.interimText &&
    state.lastInterimUpdateTime &&
    now - state.lastInterimUpdateTime >= CONFIG.INTERIM_STAGNATION_TIMEOUT &&
    state.interimText !== state.lastSentInterimText
  ) {
    const translationText = applyTextReplacements(state.interimText);
    logInfo("[SpeechAndTranslation] 暫存文字停滯，正在發送翻譯：", {
      text: state.interimText,
      translated: translationText,
      length: translationText.length
    });
    state.lastSentInterimText = state.interimText;
    sendTranslation(translationText, sourceLang);
  }
  state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(sourceLang), CONFIG.INTERIM_STAGNATION_TIMEOUT);
}

  function initializeElements() {
    const forwardRef = {};
    const missingIds = [];
    Object.entries(ELEMENT_IDS).forEach(([key, id]) => {
      forwardRef[key] = document.getElementById(id);
      console.log("[SpeechAndTranslation] Looking for element:", id, "Found:", !!forwardRef[key]);
      if (!forwardRef[key]) missingIds.push(id);
    });
    if (missingIds.length) {
      handleError("dom", MESSAGES.missingElements.replace("{ids}", missingIds.join(", ")));
      return null;
    }
    logInfo("[SpeechAndTranslation] 所有元素已初始化。");
    return forwardRef;
  }

  function initializeSpeechRecognition(sourceLanguageSelect) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
	
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = sourceLanguageSelect.value;
	
    const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
    const basePhrases = ['ちょっと', '本当', 'ありがとう', 'こんにちは', 'おはよう', '初見さん', 'スパチャ'];
    if (truncateMode === "truncate") { basePhrases.push('れいかちゃん', 'れいちゃん'); }

    const SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
    if (SpeechGrammarList) {
      const grammar = `#JSGF V1.0; grammar phrases; public <phrase> = ${basePhrases.join(' | ')} ;`;
      const speechRecognitionList = new SpeechGrammarList();
      speechRecognitionList.addFromString(grammar, 1);
      recognition.grammars = speechRecognitionList;
    }

    logInfo("[SpeechAndTranslation] 已以指定語言初始化語音識別：", recognition.lang);
	
    return recognition;
  }

  function replacePunctuation(text) {
    if (!text) return text;
	
    // const result = text.replace(/[、。]/g, " ");
    const result = text.replace(/[、。]/g, "");
    logInfo("[SpeechAndTranslation] 已替換標點符號：", {
      original: text,
      replaced: result
    });
	
    return result;
  }

  function sendTranslation(text, sourceLang) {
    const sequenceNumber = state.currentSequenceNumber++;
    logInfo("[SpeechAndTranslation] 正在發送翻譯：", {
      sequenceNumber,
      text,
      length: text.length
    });
    translateText(text, sourceLang, sequenceNumber);
    state.pendingTranslationText = "";
  }

  function startTranslationTimer(sourceLang) {
    if (state.translationTimer) {
      logInfo("[SpeechAndTranslation] 翻譯計時器已啟動，正在更新文字：", {
        text: state.pendingTranslationText,
        length: state.pendingTranslationText.length
      });
      return;
    }
	
    state.translationTimer = setTimeout(() => {
      if (state.pendingTranslationText) {
        sendTranslation(state.pendingTranslationText, sourceLang);
      }
      state.translationTimer = null;
    }, CONFIG.TRANSLATION_PENDING_TIMEOUT);
	
    logInfo("[SpeechAndTranslation] 已開始翻譯計時器：", {
      text: state.pendingTranslationText,
      length: state.pendingTranslationText.length
    });
  }

  function truncateToLastChunk(text) {
    if (!text) return text;
  
    const chunkSizeMap = {
      "ja": 40,
      "zh-TW": 30,
      "en": 110,
      "es": 110,
      "id": 110
    };
  
    const sourceLang = document.getElementById("source-language")?.value || "ja";
    const chunkSize = chunkSizeMap[sourceLang] || 40;
  
    if (text.length < chunkSize) return text;
  
    const multiple = Math.floor(text.length / chunkSize);
    const charsToRemove = multiple * chunkSize;
    logInfo("[SpeechAndTranslation] 正在截斷文字：", {
      sourceLang,
      chunkSize,
      originalLength: text.length,
      multiple,
      charsToRemove
    });
  
    return text.substring(charsToRemove);
  }
  
  //替換擷取的文字用，翻譯和顯示都會，只有在れいーモード下執行
  function applyTextReplacements(text) {
    if (!text || text.trim() === '' || text.trim() === 'っ') {
      logInfo("[SpeechAndTranslation] 跳過無效文字：", {
        original: text
      }); // 檢查單獨「っ」或空輸入
      return '';
    }
	
    const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
    if (truncateMode !== "truncate") {
      return text;
    }　// 非 truncate 模式不進行替換
	
    let result = text;
    result = result.replace(/^っ+/, '').trim(); // 移除開頭的「っ」
    Object.entries(TEXT_REPLACEMENTS).forEach(([from, to]) => {
      result = result.replaceAll(from, to);
    }); // 現有替換規則
    if (result !== text) {
      logInfo("[SpeechAndTranslation] 已套用文字替換：", {
        original: text,
        replaced: result
      });
    }
    return result;
  }
  
  // ==========================================================================
  // 初始化
  // ==========================================================================
  const elements = initializeElements();
  if (!elements) return;

  const recognition = initializeSpeechRecognition(elements.sourceLanguageSelect);
  if (!recognition) {
    handleError("browser", MESSAGES.browserNotSupported);
    return;
  }

  window.SpeechRecognitionAPI = {
    start() {
      logInfo("[SpeechAndTranslation] 嘗試啟動語音識別，狀態：", state.isRecognitionRunning);
      if (state.isRecognitionRunning) {
        console.warn("[SpeechAndTranslation]", MESSAGES.speechAlreadyRunning);
        return false;
      }

      resetState();
      state.isManuallyStopped = false;
      state.lastStopWasManual = false;
      texts.source = "";
      texts.target1 = "";
      texts.target2 = "";
      texts.target3 = "";
      logInfo("[SpeechAndTranslation] 已將 isManuallyStopped 重置為：", state.isManuallyStopped);

      recognition.lang = elements.sourceLanguageSelect.value;

      try {
        recognition.start();
        state.isRecognitionRunning = true;
        state.startTime = Date.now();
        state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);　// 啟動停滯檢查定時器
        logInfo("[SpeechAndTranslation] 語音識別已啟動。");
        updateSectionDisplay();
        return true;
      }
      catch (error) {
        state.isRecognitionRunning = false;
        handleError("start", error.message);

        return false;
      }
    },

    stop() {
      if (!ensureRecognition() || !state.isRecognitionRunning) {
        console.warn("[SpeechAndTranslation]", MESSAGES.speechNotRunning);
        return false;
      }

      state.isManuallyStopped = true;
      state.lastStopWasManual = true;
      state.ignoreTranslations = true;
      recognition.stop();
      if (state.translationTimer) {
        clearTimeout(state.translationTimer);
        state.translationTimer = null;
        state.pendingTranslationText = "";
      }
      if (state.interimStagnationTimer) {
        clearTimeout(state.interimStagnationTimer);
        state.interimStagnationTimer = null;
      }
      state.pendingResponses = {}; // 清除待處理的響應
      state.expectedSequenceNumber = state.currentSequenceNumber; // 重置序列號
      logInfo("[SpeechAndTranslation] 語音識別已停止。");
      return true;
    }
  };
  
  // ==========================================================================
  // 語音與翻譯處理
  // ==========================================================================
  recognition.onresult = function(event) {
    logInfo("[SpeechAndTranslation] 已收到語音結果，數量：", event.results.length);
    let shouldRestart = false;
    if (!event.results) {
      console.warn("[SpeechAndTranslation]", MESSAGES.invalidResults);
      return;
    }
    try {
      const displayResults = {
        finalText: "",
        interimText: ""
      };
      const translationResults = {
        finalText: state.finalText,
        interimText: ""
      };
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        if (result.isFinal) {
          shouldRestart = handleFinalResult(result, displayResults, translationResults);
        }
        else {
          handleInterimResult(result, displayResults, translationResults);
        }
      }
      handleDisplayResult(displayResults);
      handleTranslationResult(translationResults);
    }
    catch (error) {
      handleError("speech", error.message);
    }
  };
  
  recognition.onerror = (event) => {
    const errorType = event.error;
    if (errorType === "aborted") {
      console.log("[SpeechAndTranslation] Recognition aborted.");
      return;
    }
    console.warn("[SpeechAndTranslation] Speech recognition error:", errorType);
    handleError(errorType, errorType, {
      event
    });
  };
  
  recognition.onend = () => {
    logInfo("[SpeechAndTranslation] 語音識別已結束，isManuallyStopped：", state.isManuallyStopped, "lastStopWasManual:", state.lastStopWasManual, "restartAttempts:", state.restartAttempts, "elapsedTime:", state.startTime ? (Date.now() - state.startTime) / 1000 : "N/A");
    state.isRecognitionRunning = false;
    if (state.lastStopWasManual) {
      state.restartAttempts = 0;
      state.isManuallyStopped = false;
      state.lastStopWasManual = false;
      if (state.interimStagnationTimer) {
        clearTimeout(state.interimStagnationTimer);
        state.interimStagnationTimer = null;
      }
      elements.startSpeechButton.disabled = false;
      elements.stopSpeechButton.disabled = true;
      logInfo("[SpeechAndTranslation] 手動停止，正在更新 UI。");
    }
    else {
      if (state.restartAttempts < CONFIG.MAX_RESTART_ATTEMPTS) {
        logInfo(`[SpeechAndTranslation] 重新啟動嘗試 ${state.restartAttempts + 1}/${CONFIG.MAX_RESTART_ATTEMPTS}`);
        setTimeout(() => restartRecognition(), CONFIG.RESTART_DELAY);
      }
      else {
        console.error("[SpeechAndTranslation] Max restart attempts exceeded.");
        texts.source = "音声認識の再起動に失敗しました。時間制限またはネットワークエラーが原因の可能性があります。";
        texts.target1 = "";
        texts.target2 = "";
        texts.target3 = "";
        updateSectionDisplay();
        elements.startSpeechButton.disabled = false;
        elements.stopSpeechButton.disabled = true;
      }
    }
  };

  recognition.onnomatch = (event) => {
    logInfo("[SpeechAndTranslation] 語音無法辨識（onnomatch）：", {
      results: event.results ? Array.from(event.results).map(r => ({
        transcript: r[0]?.transcript || "empty",
        isFinal: r.isFinal
      })) : "無結果",
      sequenceNumber: state.sequenceNumber,
      timestamp: new Date().toISOString()
    });
  };

  function restartRecognition() {
    if (!ensureRecognition()) {
      console.warn("[SpeechAndTranslation] Cannot restart: recognition running or not supported.");
      return;
    }
    try {
      recognition.start();
      state.isRecognitionRunning = true;
      state.startTime = Date.now();
      state.ignoreTranslations = false;
      state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);
      logInfo("[SpeechAndTranslation] 語音識別已重新啟動。");
      state.restartAttempts = 0;
    }
    catch (error) {
      state.restartAttempts++;
      console.warn(`[SpeechAndTranslation] Restart attempt ${state.restartAttempts}/${CONFIG.MAX_RESTART_ATTEMPTS} failed: ${error.message}`);
      if (state.restartAttempts >= CONFIG.MAX_RESTART_ATTEMPTS) {
        console.error("[SpeechAndTranslation] Max restart attempts reached.");
        texts.source = "音声認識の再起動に失敗しました。時間制限またはネットワークエラーが原因の可能性があります。";
        texts.target1 = "";
        texts.target2 = "";
        texts.target3 = "";
        updateSectionDisplay();
        elements.startSpeechButton.disabled = false;
        elements.stopSpeechButton.disabled = true;
      }
      else {
        setTimeout(() => restartRecognition(), CONFIG.RESTART_DELAY);
      }
      handleError("restart", error.message);
    }
  }

  function handleInterimResult(result, displayResults, translationResults) {
    let transcript = result[0].transcript.trim();
    if (!transcript) {
      console.warn("[SpeechAndTranslation] Empty interim transcript received.");
      return;
    }
    const originalTranscript = transcript;
    const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
    let displayTranscript = transcript;
    let translationTranscript = transcript;
    if (truncateMode === "truncate") {
      displayTranscript = truncateToLastChunk(transcript); // 截斷顯示文字
      displayTranscript = applyTextReplacements(displayTranscript); // 替換顯示文字
      translationTranscript = applyTextReplacements(transcript); // 替換翻譯文字
    }
    if (!displayTranscript) {
      console.warn("[SpeechAndTranslation] Display transcript is empty after processing.");
      return;
    }
    logInfo("[SpeechAndTranslation] 正在處理暫存結果：", {
      original: originalTranscript,
      displayed: displayTranscript,
      translated: translationTranscript
    });
    const charCount = displayTranscript.length; // 計算顯示文字的字數
    logInfo("[SpeechAndTranslation] 暫存文字字元數：", {
      charCount
    });
    displayResults.interimText = displayTranscript; // 更新顯示結果（使用截斷和替換後的文字）
    translationResults.interimText += (translationResults.interimText ? " " : "") + translationTranscript; // 更新翻譯結果（使用替換後的文字，或原始文字若非 truncate 模式）
    if (state.shouldClearNext && translationResults.interimText) {
      translationResults.finalText = "";
      state.totalCharCount = 0;
      state.shouldClearNext = false;
      state.lastNonEmptyText = "";
    }
    state.lastInterimUpdateTime = Date.now(); // 更新臨時文字最後更新時間
    if (state.interimStagnationTimer) {
      clearTimeout(state.interimStagnationTimer);
    }
    state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);
  } // 重置停滯定時器
  
  function handleFinalResult(result, displayResults, translationResults) {
    let newText = result[0].transcript.trim();
    let shouldRestart = false;
    if (!newText) {
      console.warn("[SpeechAndTranslation] Empty final transcript received.");
      return shouldRestart;
    }
    const originalText = newText;
    const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate"; // 根據 text-truncate-mode 決定是否截斷和替換
    let displayText = newText;
    let translationText = newText;
    if (truncateMode === "truncate") {
      displayText = truncateToLastChunk(newText); // 截斷顯示文字
      displayText = applyTextReplacements(displayText); // 替換顯示文字
      translationText = applyTextReplacements(newText); // 替換翻譯文字
    }
    logInfo("[SpeechAndTranslation] 正在處理最終結果：", {
      original: originalText,
      displayed: displayText,
      translated: translationText
    });
    displayResults.finalText = displayText; // 更新顯示結果（使用截斷和替換後的文字）
    state.lastNonEmptyText = displayText;
    translationResults.finalText += (translationResults.finalText ? " " : "") + translationText; // 更新翻譯結果（使用替換後的文字，或原始文字若非 truncate 模式）
    state.totalCharCount += translationText.length;
    if (state.totalCharCount > 2) state.shouldClearNext = true;
    return shouldRestart;
  }

  function handleDisplayResult(results) {
    logInfo("[SpeechAndTranslation] 正在處理顯示結果：", {
      finalText: results.finalText,
      interimText: results.interimText,
      currentFinalText: state.finalText
    });
  
    // 獲取當前 text-align 設置
    const textAlignment = localStorage.getItem("text-alignment") || 
      document.getElementById("text-alignment-selector")?.value || 
      DEFAULT_SETTINGS.textAlignment;
  
    // 如果有臨時結果，根據 text-align 決定是否添加 < >
    if (results.interimText) {
      state.interimText = results.interimText;
      const cleanText = replacePunctuation(results.interimText);
      // 僅在 text-align: center 時添加 < >
      texts.source = textAlignment === "center" ? `< ${cleanText} >` : cleanText;
      updateSectionDisplay();
      logInfo("[SpeechAndTranslation] 使用暫存文字更新顯示：", {
        source: texts.source,
        textAlignment
      });
    }
    // 如果有最終結果，顯示臨時文字的純文字版本（應用 truncateToLastChunk）
    else if (results.finalText && state.interimText) {
      const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
      let processedText = state.interimText;
      
      if (truncateMode === "truncate") {
        processedText = truncateToLastChunk(state.interimText);
        logInfo("[SpeechAndTranslation] 已套用 truncateToLastChunk：", { processedText });
      }
      
      texts.source = replacePunctuation(processedText);
      updateSectionDisplay();
      logInfo("[SpeechAndTranslation] 在最終結果後以無符號暫存文字更新顯示：", { source: texts.source });
    }
  }

  function handleTranslationResult(results) {
    state.finalText = results.finalText;
    state.interimText = results.interimText;
    decideAndTranslate(replacePunctuation(results.finalText), elements.sourceLanguageSelect.value); // 基於最終文字進行翻譯
  }

  function decideAndTranslate(text, sourceLang) {
    if (!sourceLang) {
      handleError("invalid", "Source language is empty");
      return;
    }
    if (!text.trim()) {
      logInfo("[SpeechAndTranslation] 跳過翻譯：文字為空。");
      return;
    }
    const translationText = applyTextReplacements(text); // 對翻譯文字應用替換（若在 truncate 模式下）
    state.pendingTranslationText = translationText;
    if (translationText.length >= CONFIG.MIN_TEXT_LENGTH) {
      if (state.translationTimer) {
        clearTimeout(state.translationTimer);
        state.translationTimer = null;
      }
      sendTranslation(translationText, sourceLang);
      return;
    }
    startTranslationTimer(sourceLang);
  }
  
  /* ----------------------------------------------------------------------------
  函數:發送翻譯請求用，格式: (要翻譯的文字, 要翻譯的語言, 序號)
  ---------------------------------------------------------------------------- */
  /* ----------------------------------------------------------------------------
  函數: 發送翻譯請求
  參數: (要翻譯的文字, 來源語言, 序號)
  ---------------------------------------------------------------------------- */
  async function translateText(text, sourceLang, sequenceNumber) {
    const targetLangs = [];
    const lang1 = elements.targetLanguage1Select.value;
    const lang2 = elements.targetLanguage2Select.value;
    const lang3 = elements.targetLanguage3Select.value;
    if (lang1 && lang1 !== "none") targetLangs.push(lang1);
    if (lang2 && lang2 !== "none") targetLangs.push(lang2);
    if (lang3 && lang3 !== "none") targetLangs.push(lang3);
    if (!targetLangs.length) {
      logInfo("[SpeechAndTranslation] 未選擇目標語言。");
      updateSectionDisplay();
      return;
    }
    logInfo("[SpeechAndTranslation] 正在發送翻譯請求：", {
      sequenceNumber,
      text,
      targetLangs
    });
    const timeoutId = setTimeout(() => {
      if (sequenceNumber === state.expectedSequenceNumber) {
        logInfo(`[SpeechAndTranslation] 翻譯逾時（序列： ${sequenceNumber})`);
        state.expectedSequenceNumber++;
        processPendingResponses();
      }
    }, CONFIG.TRANSLATION_TIMEOUT);
  
    try {
      const apiMode = elements.apiMode?.value || 'backend';
      if (apiMode === 'openai') {
        await translateWithOpenAI(text, sourceLang, targetLangs, sequenceNumber, timeoutId);
      } else if (apiMode === 'gemini') {
        // 未來 Gemini 支援，暫記錄日誌
        logInfo("[SpeechAndTranslation] Gemini API 尚未實作：", { sequenceNumber, text });
        clearTimeout(timeoutId);
        throw new Error("Gemini API 尚未支援");
      } else {
        // 使用原有服務 URL
        const serviceUrl = document.getElementById("api-key-input").value.trim();
        const apiKey = document.getElementById("api-key-value").value.trim();
        if (!serviceUrl) throw new Error("Service URL is empty.");
        if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?\/.+$/.test(serviceUrl)) {
          throw new Error("Invalid URL format.");
        }
        const headers = {
          "Content-Type": "application/json"
        };
        if (apiKey) headers["X-API-Key"] = apiKey;
        const response = await fetch(serviceUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            text,
            targetLangs
          })
        });
  
        clearTimeout(timeoutId);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        logInfo("[SpeechAndTranslation] 已接收翻譯：", {
          sequenceNumber,
          translations: data.translations
        });
        handleTranslationResponse(sequenceNumber, text, data.translations, null);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      handleError("translation", error.message, {
        sequenceNumber,
        text
      });
    }
  }

  /**
   * 使用 OpenAI API 進行翻譯
   * @param {string} text - 要翻譯的文字
   * @param {string} sourceLang - 要來源語言（例如 "ja"）
   * @param {string[]} targetLangs - 目標語言陣列（例如 ["zh-TW", "en"]）
   * @param {number} sequenceNumber - 翻譯請求序列號
   * @param {number} timeoutId - 超時定時器 ID，用於清除超時
   */
  async function translateWithOpenAI(text, sourceLang, targetLangs, sequenceNumber, timeoutId) {
    // 從 DOM 讀取 OpenAI API Key
    const apiKey = document.getElementById("api-key-value").value.trim();
    if (!apiKey) {
      throw new Error("OpenAI API Key 不可為空。");
    }
    if (!apiKey.startsWith('sk-')) {
      throw new Error("無效的 OpenAI API Key 格式。");
    }
  
    const openaiUrl = "https://api.openai.com/v1/chat/completions";
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
  
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `你是一位專業翻譯者。將 "${text}" 從 ${sourceLang} 翻譯成 ${targetLangs.join("、")}，僅回傳純 JSON 陣列，按目標語言順序，例如 ["翻譯1", "翻譯2"]，禁止包含 Markdown 程式碼區塊、說明或其他格式。`
        },
        {
          role: "user",
          content: text
        }
      ],
      max_tokens: 300, // 參考後端，限制輸出長度
      temperature: 0.1 // 與後端一致，略微提高確定性
    });
  
    try {
      const response = await fetch(openaiUrl, {
        method: "POST",
        headers,
        body
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API 錯誤：${response.status} - ${errorText}`);
      }
  
      const data = await response.json();
      let translations = [];
      try {
        let content = data.choices[0]?.message.content || '[]';
        // 增強清理邏輯，移除多種 Markdown 變體
        content = content
          .replace(/^```(json)?\n|\n```$/g, '') // 移除 ```json 或 ```
          .replace(/^`+|\n`+$/g, '')          // 移除單獨的 ` 標記
          .trim();                             // 去除多餘空白
        logInfo("[SpeechAndTranslation] 清理後的 OpenAI 回應內容：", { content });
        translations = JSON.parse(content);
        if (!Array.isArray(translations)) {
          throw new Error("回應不是有效的 JSON 陣列。");
        }
      } catch (e) {
        logInfo("[SpeechAndTranslation] 回應解析失敗，原始內容：", {
          rawContent: data.choices[0]?.message.content
        });
        throw new Error(`無效的 OpenAI 回應格式：${e.message}`);
      }
  
      logInfo("[SpeechAndTranslation] 已接收 OpenAI 翻譯：", {
        sequenceNumber,
        translations,
        usage: data.usage
      });
  
      clearTimeout(timeoutId);
      handleTranslationResponse(sequenceNumber, text, translations, null);
    } catch (error) {
      // 顯示用戶友好的錯誤提示
      const apiHint = document.getElementById('api-hint');
      if (apiHint && error.message.includes('無效的 OpenAI 回應格式')) {
        apiHint.textContent = 'OpenAI 回應格式錯誤，請檢查 API Key 或稍後重試';
        apiHint.style.color = 'red';
      }
      throw error;
    }
  }

  function handleTranslationResponse(sequenceNumber, text, translations, errorMessage) {
    if (state.ignoreTranslations) {
      logInfo("[SpeechAndTranslation] 手動停止後忽略翻譯回應：", {
        sequenceNumber
      });
      return;
    }
    if (sequenceNumber < state.expectedSequenceNumber) return;
    if (sequenceNumber === state.expectedSequenceNumber) {
      applyTranslationResponse(text, translations, errorMessage);
      state.expectedSequenceNumber++;
      processPendingResponses();
      return;
    }
    if (Object.keys(state.pendingResponses).length >= CONFIG.MAX_PENDING_RESPONSES) {
      const oldestSequence = Math.min(...Object.keys(state.pendingResponses).map(Number));
      delete state.pendingResponses[oldestSequence];
    }
    state.pendingResponses[sequenceNumber] = {
      text,
      translations,
      errorMessage
    };
  }

  function applyTranslationResponse(text, translations, errorMessage) {
    const lang1 = elements.targetLanguage1Select.value;
    const lang2 = elements.targetLanguage2Select.value;
    const lang3 = elements.targetLanguage3Select.value;
    if (errorMessage) {
      texts.target1 = lang1 && lang1 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
      texts.target2 = lang2 && lang2 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
      texts.target3 = lang3 && lang3 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
      updateSectionDisplay({
        skipSource: true
      });
      return;
    }
    const now = Date.now();
    const isLongText = text.length > 40;
    const newTranslations = [
      lang1 && lang1 !== "none" && translations && translations.length > 0 ? replacePunctuation(translations[0] || "") : "",
      lang2 && lang2 !== "none" && translations && translations.length > 1 ? replacePunctuation(translations[1] || "") : "",
      lang3 && lang3 !== "none" && translations && translations.length > 2 ? replacePunctuation(translations[2] || "") : ""
    ];
    ['target1', 'target2', 'target3'].forEach((key, index) => {
      const buffer = state.displayBuffer[key];
      if (isLongText) {
        buffer.text = newTranslations[index];
        buffer.timestamp = now;
        texts[key] = newTranslations[index];
      }
      else if (buffer.text && now - buffer.timestamp < buffer.minDisplayTime) {
        return;
      }
      else {
        texts[key] = newTranslations[index];
      }
    });
    updateSectionDisplay({
      skipSource: true
    });
  }

  function processPendingResponses() {
    while (state.pendingResponses[state.expectedSequenceNumber]) {
      const {
        text,
        translations,
        errorMessage
      } = state.pendingResponses[state.expectedSequenceNumber];
      applyTranslationResponse(text, translations, errorMessage);
      delete state.pendingResponses[state.expectedSequenceNumber];
      state.expectedSequenceNumber++;
    }
  }
  // ==========================================================================
  // UI 更新
  // ==========================================================================
  function updateSectionDisplay(options = {}) {
    const {
      skipSource = false
    } = options;
    const section = document.getElementById("section-1");
    if (!section) {
      console.error("[SpeechAndTranslation] Section #section-1 not found.");
      return;
    }
    const container = section.querySelector(".scroll-container");
    if (!container) {
      console.error("[SpeechAndTranslation] Scroll container not found.");
      return;
    }
    const spans = {
      source: container.querySelector(".source-text"),
      target1: container.querySelector(".target-text-1"),
      target2: container.querySelector(".target-text-2"),
      target3: container.querySelector(".target-text-3")
    };
    if (!spans.source || !spans.target1 || !spans.target2 || !spans.target3) {
      console.error("[SpeechAndTranslation] One or more text spans not found:", spans);
      return;
    }
    const entries = [{
        span: spans.source,
        key: "source",
        lang: "source-language"
      },
      {
        span: spans.target1,
        key: "target1",
        lang: "target-language1"
      },
      {
        span: spans.target2,
        key: "target2",
        lang: "target-language2"
      },
      {
        span: spans.target3,
        key: "target3",
        lang: "target-language3"
      }
    ];
    entries.forEach(({
      span,
      key
    }) => {
      if (skipSource && key === "source") return;
      if (span.textContent !== texts[key]) {
        span.textContent = texts[key];
        span.setAttribute("data-stroke", texts[key]);
        span.style.display = 'inline-block';
        span.offsetHeight;
        span.style.display = '';
      }
    });
    if (DEBUG) {
      logInfo("[SpeechAndTranslation] 已更新 UI spans：", {
        source: {
          text: spans.source.textContent,
          stroke: spans.source.getAttribute("data-stroke")
        },
        target1: {
          text: spans.target1.textContent,
          stroke: spans.target1.getAttribute("data-stroke")
        },
        target2: {
          text: spans.target2.textContent,
          stroke: spans.target2.getAttribute("data-stroke")
        },
        target3: {
          text: spans.target3.textContent,
          stroke: spans.target3.getAttribute("data-stroke")
        }
      });
    }
    logInfo("[SpeechAndTranslation] UI 已更新。");
  }
  // ==========================================================================
  // 事件綁定
  // ==========================================================================
  logInfo("[SpeechAndTranslation] 正在綁定事件監聽器。");
  elements.startSpeechButton.addEventListener("click", () => {
    logInfo("[SpeechAndTranslation] 點擊開始按鈕。");
    if (window.SpeechRecognitionAPI.start()) {
      elements.startSpeechButton.disabled = true;
      elements.stopSpeechButton.disabled = false;
      elements.startSpeechButton.classList.add("pressed");
      setTimeout(() => elements.startSpeechButton.classList.remove("pressed"), 200);
    }
  }, {
    capture: true
  });
  elements.stopSpeechButton.addEventListener("click", () => {
    logInfo("[SpeechAndTranslation] 點擊停止按鈕。");
    if (window.SpeechRecognitionAPI.stop()) {
      elements.startSpeechButton.disabled = false;
      elements.stopSpeechButton.disabled = true;
      elements.stopSpeechButton.classList.add("pressed");
      setTimeout(() => elements.stopSpeechButton.classList.remove("pressed"), 200);
    }
  }, {
    capture: true
  });
  elements.sourceLanguageSelect.addEventListener("change", () => {
    recognition.lang = elements.sourceLanguageSelect.value;
    logInfo("[SpeechAndTranslation] 已將來源語言更新為：", recognition.lang);
  });
  [elements.targetLanguage1Select, elements.targetLanguage2Select, elements.targetLanguage3Select].forEach((select, index) => {
    select.addEventListener("change", () => {
      const langKey = `target${index + 1}`;
      if (select.value === "none") {
        texts[langKey] = "";
        updateSectionDisplay();
        logInfo(`[SpeechAndTranslation] 由於選擇 'none'，已清除 ${langKey}。`);
      }
    });
  });
});
