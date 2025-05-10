const DEBUG = false;
function logInfo(...args) {
	if (DEBUG) {
        console.info(...args);
	}
}

document.addEventListener("DOMContentLoaded", () => {
    logInfo("[SpeechAndTranslation] Script loaded.");

    // ==========================================================================
    // 常量與配置
    // ==========================================================================
    const CONFIG = {
        MAX_RESTART_ATTEMPTS: 5,
        MAX_TIME_LIMIT: 300 * 1000,
        TRANSLATION_TIMEOUT: 3000,
        MAX_PENDING_RESPONSES: 10,
        RESTART_DELAY: 500,
        MIN_TEXT_LENGTH: 5,
        TRANSLATION_PENDING_TIMEOUT: 2000,
        INTERIM_STAGNATION_TIMEOUT: 3000 // 新增：臨時文字停滯超時
    };

    const ELEMENT_IDS = {
        startSpeechButton: "start-recording",
        stopSpeechButton: "stop-recording",
        sourceLanguageSelect: "source-language",
        targetLanguage1Select: "target-language1",
        targetLanguage2Select: "target-language2",
        targetLanguage3Select: "target-language3"
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

	const DEFAULT_TEXTS = {
		source: "[トリアンの字幕アトリエ] 緊急事態発生！！¶ゞ(；￣∀￣)ノ☆避難せよ～！",
		target1: "開発者：[ 乙夏れいのファン 夏族ジュノーン & Grok 3 ]",
		target2: "----",
		target3: "著作権 © 2025｜改変・複製・自由使用可、販売および作者の偽称は禁止"
	};
	
    const DEBUG = true;

    // ==========================================================================
    // 狀態與文字
    // ==========================================================================
    const state = {
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
        lastInterimUpdateTime: null, // 新增：記錄臨時文字最後更新時間
        lastSentInterimText: "", // 新增：記錄最後發送的臨時文字
        interimStagnationTimer: null, // 新增：臨時文字停滯定時器
        displayBuffer: {
            target1: { text: "", timestamp: 0, minDisplayTime: 5000 },
            target2: { text: "", timestamp: 0, minDisplayTime: 5000 },
            target3: { text: "", timestamp: 0, minDisplayTime: 5000 }
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
            lastInterimUpdateTime: null, // 新增
            lastSentInterimText: "", // 新增
            interimStagnationTimer: null // 新增
        });
        logInfo("[SpeechAndTranslation] State reset.");
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
            !state.finalText && // 確保沒有最終文字
            state.interimText !== state.lastSentInterimText // 避免重複發送
        ) {
            logInfo("[SpeechAndTranslation] Interim text stagnated, sending for translation:", {
                text: state.interimText,
                length: state.interimText.length
            });
            state.lastSentInterimText = state.interimText; // 記錄已發送的臨時文字
            sendTranslation(state.interimText, sourceLang); // 發送翻譯
        }
        // 重新啟動定時器以持續檢查
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

        logInfo("[SpeechAndTranslation] All elements initialized.");
        return forwardRef;
    }

    function initializeSpeechRecognition(sourceLanguageSelect) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 3;
        recognition.lang = sourceLanguageSelect.value;

        logInfo("[SpeechAndTranslation] Speech recognition initialized with language:", recognition.lang);
        return recognition;
    }

    function replacePunctuation(text) {
        if (!text) return text;
        const result = text.replace(/[、。]/g, " ");
        logInfo("[SpeechAndTranslation] Punctuation replaced:", { original: text, replaced: result });
        return result;
    }

    function sendTranslation(text, sourceLang) {
        const sequenceNumber = state.currentSequenceNumber++;
        logInfo("[SpeechAndTranslation] Sending translation:", {
            sequenceNumber,
            text,
            length: text.length
        });
        translateText(text, sourceLang, sequenceNumber);
        state.pendingTranslationText = "";
    }

    function startTranslationTimer(sourceLang) {
        if (state.translationTimer) {
            logInfo("[SpeechAndTranslation] Translation timer already running, updating text:", {
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

        logInfo("[SpeechAndTranslation] Started translation timer:", {
            text: state.pendingTranslationText,
            length: state.pendingTranslationText.length
        });
    }

    function truncateToLastChunk(text) {
        if (!text || text.length < 40) return text;
        const chunkSize = 40;
        const multiple = Math.floor(text.length / chunkSize);
        const charsToRemove = multiple * chunkSize;
        logInfo("[SpeechAndTranslation] Truncating text:", {
            originalLength: text.length,
            multiple,
            charsToRemove
        });
        return text.substring(charsToRemove);
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
            logInfo("[SpeechAndTranslation] Attempting to start speech recognition, state:", state.isRecognitionRunning);
            if (state.isRecognitionRunning) {
                console.warn("[SpeechAndTranslation]", MESSAGES.speechAlreadyRunning);
                return false;
            }

            resetState();
            state.isManuallyStopped = false;
            state.lastStopWasManual = false;
            logInfo("[SpeechAndTranslation] isManuallyStopped reset to:", state.isManuallyStopped);
            recognition.lang = elements.sourceLanguageSelect.value;

            try {
                recognition.start();
                state.isRecognitionRunning = true;
                state.startTime = Date.now();
                // 啟動停滯檢查定時器
                state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);
                logInfo("[SpeechAndTranslation] Speech recognition started.");
                updateSectionDisplay();
                return true;
            } catch (error) {
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
            // 清除待處理的響應
            state.pendingResponses = {};
            state.expectedSequenceNumber = state.currentSequenceNumber; // 重置序列號
            logInfo("[SpeechAndTranslation] Speech recognition stopped.");
            return true;
        }
    };

    // ==========================================================================
    // 語音與翻譯處理
    // ==========================================================================
    recognition.onresult = function(event) {
        logInfo("[SpeechAndTranslation] Received speech results, count:", event.results.length);
        let shouldRestart = false;

        if (!event.results) {
            console.warn("[SpeechAndTranslation]", MESSAGES.invalidResults);
            return;
        }

        try {
            const displayResults = { finalText: "", interimText: "" };
            const translationResults = { finalText: state.finalText, interimText: "" };

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (!result) continue;

                if (result.isFinal) {
                    shouldRestart = handleFinalResult(result, displayResults, translationResults);
                } else {
                    handleInterimResult(result, displayResults, translationResults);
                }
            }

            // Update display
            handleDisplayResult(displayResults);

            // Handle translation
            handleTranslationResult(translationResults);

            if (shouldRestart) {
                logInfo(`[SpeechAndTranslation] Time limit (${CONFIG.MAX_TIME_LIMIT / 1000}s) reached, restarting.`);
                recognition.stop();
                setTimeout(() => restartRecognition(), CONFIG.RESTART_DELAY);
            }
        } catch (error) {
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
        handleError(errorType, errorType, { event });
    };

    recognition.onend = () => {
        logInfo("[SpeechAndTranslation] Speech recognition ended, isManuallyStopped:", state.isManuallyStopped, "lastStopWasManual:", state.lastStopWasManual, "restartAttempts:", state.restartAttempts, "elapsedTime:", state.startTime ? (Date.now() - state.startTime) / 1000 : "N/A");
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
            logInfo("[SpeechAndTranslation] Manually stopped, updating UI.");
        } else {
            if (state.restartAttempts < CONFIG.MAX_RESTART_ATTEMPTS) {
                logInfo(`[SpeechAndTranslation] Restart attempt ${state.restartAttempts + 1}/${CONFIG.MAX_RESTART_ATTEMPTS}`);
                setTimeout(() => restartRecognition(), CONFIG.RESTART_DELAY);
            } else {
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

    function restartRecognition() {
        if (!ensureRecognition() || state.isRecognitionRunning) {
            console.warn("[SpeechAndTranslation] Cannot restart: recognition running or not supported.");
            return;
        }

        try {
            recognition.start();
            state.isRecognitionRunning = true;
            state.startTime = Date.now();
            state.ignoreTranslations = false;
            // 重新啟動停滯檢查定時器
            state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);
            logInfo("[SpeechAndTranslation] Speech recognition restarted.");
            state.restartAttempts = 0;
        } catch (error) {
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
            } else {
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

        // 保留原始文字用於翻譯
        const originalTranscript = transcript;

        // 根據 text-truncate-mode 決定是否截斷
        const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
        const displayTranscript = truncateMode === "truncate" ? truncateToLastChunk(transcript) : transcript;
        if (!displayTranscript) {
            console.warn("[SpeechAndTranslation] Display transcript is empty after processing.");
            return;
        }

        logInfo("[SpeechAndTranslation] Processing interim result:", {
            original: originalTranscript,
            displayed: displayTranscript
        });

        // 計算顯示文字的字數
        const charCount = displayTranscript.length;
        logInfo("[SpeechAndTranslation] Interim text character count:", { charCount });

        // 更新顯示結果（使用截斷或完整文字）
        displayResults.interimText = displayTranscript;

        // 更新翻譯結果（使用原始文字）
        translationResults.interimText += (translationResults.interimText ? " " : "") + originalTranscript;

        if (state.shouldClearNext && translationResults.interimText) {
            translationResults.finalText = "";
            state.totalCharCount = 0;
            state.shouldClearNext = false;
            state.lastNonEmptyText = "";
        }

        // 更新臨時文字最後更新時間
        state.lastInterimUpdateTime = Date.now();

        // 重置停滯定時器
        if (state.interimStagnationTimer) {
            clearTimeout(state.interimStagnationTimer);
        }
        state.interimStagnationTimer = setTimeout(() => checkInterimStagnation(elements.sourceLanguageSelect.value), CONFIG.INTERIM_STAGNATION_TIMEOUT);
    }

    function handleFinalResult(result, displayResults, translationResults) {
        let newText = result[0].transcript.trim();
        let shouldRestart = false;

        if (!newText) {
            console.warn("[SpeechAndTranslation] Empty final transcript received.");
            return shouldRestart;
        }

        // 保留原始文字用於翻譯
        const originalText = newText;

        // 根據 text-truncate-mode 決定是否截斷（雖然目前不顯示）
        const truncateMode = localStorage.getItem("text-truncate-mode") || "truncate";
        newText = truncateMode === "truncate" ? truncateToLastChunk(newText) : newText;

        logInfo("[SpeechAndTranslation] Processing final result:", {
            original: originalText,
            displayed: newText
        });

        // 更新顯示結果（保留邏輯，但不影響畫面）
        displayResults.finalText = newText;
        state.lastNonEmptyText = newText;

        // 更新翻譯結果（使用原始文字）
        translationResults.finalText += (translationResults.finalText ? " " : "") + originalText;
        state.totalCharCount += originalText.length;
        if (state.totalCharCount > 2) state.shouldClearNext = true;

        if (state.startTime && Date.now() - state.startTime >= CONFIG.MAX_TIME_LIMIT) {
            shouldRestart = true;
            state.restartAttempts = 0;
            logInfo("[SpeechAndTranslation] Time limit reached, preparing to restart.");
        }

        return shouldRestart;
    }

    function handleDisplayResult(results) {
        logInfo("[SpeechAndTranslation] Handling display results:", {
            finalText: results.finalText,
            interimText: results.interimText,
            currentFinalText: state.finalText
        });

        // 如果有臨時結果，且存在前次最終結果，清除前次最終結果
        if (results.interimText && state.finalText) {
            logInfo("[SpeechAndTranslation] Clearing previous final result before displaying new interim result.");
            state.finalText = "";
            state.interimText = "";
            texts.source = ""; // 使用零寬度空格作為佔位
            updateSectionDisplay();
        }

        // 僅顯示臨時結果，忽略最終結果
        if (results.interimText) {
            state.interimText = results.interimText;
            texts.source = replacePunctuation(results.interimText);
            updateSectionDisplay();
            logInfo("[SpeechAndTranslation] Display updated with:", { source: texts.source });
        }
    }

    function handleTranslationResult(results) {
        state.finalText = results.finalText;
        state.interimText = results.interimText;

        // 基於最終文字進行翻譯
        decideAndTranslate(results.finalText, elements.sourceLanguageSelect.value);
    }

    function decideAndTranslate(text, sourceLang) {
        if (!sourceLang) {
            handleError("invalid", "Source language is empty");
            return;
        }
        if (!text.trim()) {
            logInfo("[SpeechAndTranslation] Skipping translation: empty text.");
            return;
        }

        state.pendingTranslationText = text;

        if (text.length >= CONFIG.MIN_TEXT_LENGTH) {
            if (state.translationTimer) {
                clearTimeout(state.translationTimer);
                state.translationTimer = null;
            }
            sendTranslation(text, sourceLang);
            return;
        }

        startTranslationTimer(sourceLang);
    }

	/* ----------------------------------------------------------------------------
	函數:發送翻譯請求用，格式: (要翻譯的文字, 要翻譯的語言, 序號)
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
            logInfo("[SpeechAndTranslation] No target languages selected.");
            updateSectionDisplay();
            return;
        }

        logInfo("[SpeechAndTranslation] Sending translation request:", { sequenceNumber, text, targetLangs });

        const timeoutId = setTimeout(() => {
            if (sequenceNumber === state.expectedSequenceNumber) {
                logInfo(`[SpeechAndTranslation] Translation timeout (sequence: ${sequenceNumber})`);
                state.expectedSequenceNumber++;
                processPendingResponses();
            }
        }, CONFIG.TRANSLATION_TIMEOUT);

        try {
            const serviceUrl = document.getElementById("api-key-input").value.trim();
            const apiKey = document.getElementById("api-key-value").value.trim();
            if (!serviceUrl) throw new Error("Service URL is empty.");
            if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?\/.+$/.test(serviceUrl)) {
                throw new Error("Invalid URL format.");
            }

            const headers = { "Content-Type": "application/json" };
            if (apiKey) headers["X-API-Key"] = apiKey;

            const response = await fetch(serviceUrl, {
                method: "POST",
                headers: headers,
                body: JSON.stringify({ text, targetLangs })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            logInfo("[SpeechAndTranslation] Translation received:", { sequenceNumber, translations: data.translations });
            handleTranslationResponse(sequenceNumber, text, data.translations, null);
        } catch (error) {
            clearTimeout(timeoutId);
            handleError("translation", error.message, { sequenceNumber, text });
        }
    }

    function handleTranslationResponse(sequenceNumber, text, translations, errorMessage) {
		if (state.ignoreTranslations) {
        logInfo("[SpeechAndTranslation] Ignoring translation response after manual stop:", { sequenceNumber });
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
        state.pendingResponses[sequenceNumber] = { text, translations, errorMessage };
    }

    function applyTranslationResponse(text, translations, errorMessage) {
        const lang1 = elements.targetLanguage1Select.value;
        const lang2 = elements.targetLanguage2Select.value;
        const lang3 = elements.targetLanguage3Select.value;

        if (errorMessage) {
            texts.target1 = lang1 && lang1 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
            texts.target2 = lang2 && lang2 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
            texts.target3 = lang3 && lang3 !== "none" ? `翻訳エラー: ${errorMessage}` : "";
            updateSectionDisplay({ skipSource: true });
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
            } else if (buffer.text && now - buffer.timestamp < buffer.minDisplayTime) {
                return;
            } else {
                texts[key] = newTranslations[index];
            }
        });

        updateSectionDisplay({ skipSource: true });
    }

    function processPendingResponses() {
        while (state.pendingResponses[state.expectedSequenceNumber]) {
            const { text, translations, errorMessage } = state.pendingResponses[state.expectedSequenceNumber];
            applyTranslationResponse(text, translations, errorMessage);
            delete state.pendingResponses[state.expectedSequenceNumber];
            state.expectedSequenceNumber++;
        }
    }

    // ==========================================================================
    // UI 更新
    // ==========================================================================
    function updateSectionDisplay(options = {}) {
        const { skipSource = false } = options;
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

        const entries = [
            { span: spans.source, key: "source", lang: "source-language" },
            { span: spans.target1, key: "target1", lang: "target-language1" },
            { span: spans.target2, key: "target2", lang: "target-language2" },
            { span: spans.target3, key: "target3", lang: "target-language3" }
        ];

        entries.forEach(({ span, key }) => {
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
            logInfo("[SpeechAndTranslation] Updated UI spans:", {
                source: { text: spans.source.textContent, stroke: spans.source.getAttribute("data-stroke") },
                target1: { text: spans.target1.textContent, stroke: spans.target1.getAttribute("data-stroke") },
                target2: { text: spans.target2.textContent, stroke: spans.target2.getAttribute("data-stroke") },
                target3: { text: spans.target3.textContent, stroke: spans.target3.getAttribute("data-stroke") }
            });
        }
        logInfo("[SpeechAndTranslation] UI updated.");
    }

    // ==========================================================================
    // 事件綁定
    // ==========================================================================
    logInfo("[SpeechAndTranslation] Binding event listeners.");
    elements.startSpeechButton.addEventListener("click", () => {
        logInfo("[SpeechAndTranslation] Start button clicked.");
        if (window.SpeechRecognitionAPI.start()) {
            elements.startSpeechButton.disabled = true;
            elements.stopSpeechButton.disabled = false;
            elements.startSpeechButton.classList.add("pressed");
            setTimeout(() => elements.startSpeechButton.classList.remove("pressed"), 200);
        }
    }, { capture: true });

    elements.stopSpeechButton.addEventListener("click", () => {
        logInfo("[SpeechAndTranslation] Stop button clicked.");
        if (window.SpeechRecognitionAPI.stop()) {
            window.location.reload();
            elements.startSpeechButton.disabled = false;
            elements.stopSpeechButton.disabled = true;
            elements.stopSpeechButton.classList.add("pressed");
            setTimeout(() => elements.stopSpeechButton.classList.remove("pressed"), 200);
            Object.assign(texts, DEFAULT_TEXTS);
            updateSectionDisplay();
        }
    }, { capture: true });

    elements.sourceLanguageSelect.addEventListener("change", () => {
        recognition.lang = elements.sourceLanguageSelect.value;
        logInfo("[SpeechAndTranslation] Source language updated to:", recognition.lang);
    });

    [elements.targetLanguage1Select, elements.targetLanguage2Select, elements.targetLanguage3Select].forEach((select, index) => {
        select.addEventListener("change", () => {
            const langKey = `target${index + 1}`;
            if (select.value === "none") {
                texts[langKey] = "";
                updateSectionDisplay();
                logInfo(`[SpeechAndTranslation] Cleared ${langKey} due to 'none' selection.`);
            }
        });
    });
});