document.addEventListener("DOMContentLoaded", () => {
    console.info("[SpeechAndTranslation] Script loaded.");

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
        TRANSLATION_PENDING_TIMEOUT: 2000
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

    const DEBUG = false;

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
        lastStopWasManual: false
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
            lastStopWasManual: false
        });
        console.info("[SpeechAndTranslation] State reset.");
    }

    function ensureRecognition() {
        if (!recognition) {
            handleError("browser", MESSAGES.browserNotSupported);
            return false;
        }
        return true;
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

        console.info("[SpeechAndTranslation] All elements initialized.");
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

        console.info("[SpeechAndTranslation] Speech recognition initialized with language:", recognition.lang);
        return recognition;
    }

    function sendTranslation(text, sourceLang) {
        const sequenceNumber = state.currentSequenceNumber++;
        console.info("[SpeechAndTranslation] Sending translation:", {
            sequenceNumber,
            text,
            length: text.length
        });
        translateText(text, sourceLang, sequenceNumber);
        state.pendingTranslationText = "";
    }

    function startTranslationTimer(sourceLang) {
        if (state.translationTimer) {
            console.info("[SpeechAndTranslation] Translation timer already running, updating text:", {
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

        console.info("[SpeechAndTranslation] Started translation timer:", {
            text: state.pendingTranslationText,
            length: state.pendingTranslationText.length
        });
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
            console.info("[SpeechAndTranslation] Attempting to start speech recognition, state:", state.isRecognitionRunning);
            if (state.isRecognitionRunning) {
                console.warn("[SpeechAndTranslation]", MESSAGES.speechAlreadyRunning);
                return false;
            }

            resetState();
            state.isManuallyStopped = false;
            state.lastStopWasManual = false;
            console.info("[SpeechAndTranslation] isManuallyStopped reset to:", state.isManuallyStopped);
            recognition.lang = elements.sourceLanguageSelect.value;

            try {
                recognition.start();
                state.isRecognitionRunning = true;
                state.startTime = Date.now();
                console.info("[SpeechAndTranslation] Speech recognition started.");
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
            recognition.stop();
            if (state.translationTimer) {
                clearTimeout(state.translationTimer);
                state.translationTimer = null;
                state.pendingTranslationText = "";
            }
            console.info("[SpeechAndTranslation] Speech recognition stopped.");
            return true;
        }
    };

    // ==========================================================================
    // 語音與翻譯處理
    // ==========================================================================
    recognition.onresult = function(event) {
        console.info("[SpeechAndTranslation] Received speech results, count:", event.results.length);
        let newInterimText = "";
        let shouldRestart = false;

        if (!event.results) {
            console.warn("[SpeechAndTranslation]", MESSAGES.invalidResults);
            return;
        }

        try {
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (!result) continue;

                if (result.isFinal) {
                    shouldRestart = handleFinalResult(result);
                } else {
                    newInterimText = handleInterimResult(result, newInterimText);
                }
            }

            if (newInterimText) {
                state.interimText = newInterimText;
                texts.source = state.finalText + (newInterimText ? " " : "") + newInterimText;
                updateSectionDisplay();
            }

            if (shouldRestart) {
                console.info(`[SpeechAndTranslation] Time limit (${CONFIG.MAX_TIME_LIMIT / 1000}s) reached, restarting.`);
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
        console.info("[SpeechAndTranslation] Speech recognition ended, isManuallyStopped:", state.isManuallyStopped, "lastStopWasManual:", state.lastStopWasManual, "restartAttempts:", state.restartAttempts, "elapsedTime:", state.startTime ? (Date.now() - state.startTime) / 1000 : "N/A");
        state.isRecognitionRunning = false;
        if (state.lastStopWasManual) {
            state.restartAttempts = 0;
            state.isManuallyStopped = false;
            state.lastStopWasManual = false;
            elements.startSpeechButton.disabled = false;
            elements.stopSpeechButton.disabled = true;
            console.info("[SpeechAndTranslation] Manually stopped, updating UI.");
        } else {
            if (state.restartAttempts < CONFIG.MAX_RESTART_ATTEMPTS) {
                console.info(`[SpeechAndTranslation] Restart attempt ${state.restartAttempts + 1}/${CONFIG.MAX_RESTART_ATTEMPTS}`);
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
            console.info("[SpeechAndTranslation] Speech recognition restarted.");
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

    function handleFinalResult(result) {
        let newText = result[0].transcript.trim();
        let shouldRestart = false;

        if (!newText) return shouldRestart;

        state.finalText += (state.finalText ? " " : "") + newText;
        state.totalCharCount += newText.length;
        if (state.totalCharCount > 20) state.shouldClearNext = true;
        texts.source = state.finalText;
        state.lastNonEmptyText = newText;

        decideAndTranslate(state.finalText, elements.sourceLanguageSelect.value);

        if (state.startTime && Date.now() - state.startTime >= CONFIG.MAX_TIME_LIMIT) {
            shouldRestart = true;
            state.restartAttempts = 0;
            console.info("[SpeechAndTranslation] Time limit reached, preparing to restart.");
        }

        return shouldRestart;
    }

    function handleInterimResult(result, newInterimText) {
        const transcript = result[0].transcript.trim();
        if (!transcript) return newInterimText;

        newInterimText += (newInterimText ? " " : "") + transcript;

        if (state.shouldClearNext && newInterimText) {
            state.finalText = "";
            state.totalCharCount = 0;
            state.shouldClearNext = false;
            texts.source = "";
            state.lastNonEmptyText = "";
        }

        return newInterimText;
    }

    function decideAndTranslate(text, sourceLang) {
        if (!sourceLang) {
            handleError("invalid", "Source language is empty");
            return;
        }
        if (!text.trim()) {
            console.info("[SpeechAndTranslation] Skipping translation: empty text.");
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

    async function translateText(text, sourceLang, sequenceNumber) {
        const targetLangs = [];
        const lang1 = elements.targetLanguage1Select.value;
        const lang2 = elements.targetLanguage2Select.value;
        const lang3 = elements.targetLanguage3Select.value;

        if (lang1 && lang1 !== "none") targetLangs.push(lang1);
        if (lang2 && lang2 !== "none") targetLangs.push(lang2);
        if (lang3 && lang3 !== "none") targetLangs.push(lang3);

        if (!targetLangs.length) {
            console.info("[SpeechAndTranslation] No target languages selected.");
            updateSectionDisplay();
            return;
        }

        console.info("[SpeechAndTranslation] Sending translation request:", { sequenceNumber, text, targetLangs });

        const timeoutId = setTimeout(() => {
            if (sequenceNumber === state.expectedSequenceNumber) {
                console.info(`[SpeechAndTranslation] Translation timeout (sequence: ${sequenceNumber})`);
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
            console.info("[SpeechAndTranslation] Translation received:", { sequenceNumber, translations: data.translations });
            handleTranslationResponse(sequenceNumber, text, data.translations, null);
        } catch (error) {
            clearTimeout(timeoutId);
            handleError("translation", error.message, { sequenceNumber, text });
        }
    }

    function handleTranslationResponse(sequenceNumber, text, translations, errorMessage) {
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
            updateSectionDisplay();
            return;
        }

        const targetLangs = [];
        if (lang1 && lang1 !== "none") targetLangs.push(lang1);
        if (lang2 && lang2 !== "none") targetLangs.push(lang2);
        if (lang3 && lang3 !== "none") targetLangs.push(lang3);

        console.info("[SpeechAndTranslation] Applying translations:", { targetLangs, translations });

        texts.target1 = lang1 && lang1 !== "none" && translations && translations.length > 0 ? translations[0] || "" : "";
        texts.target2 = lang2 && lang2 !== "none" && translations && translations.length > 1 ? translations[1] || "" : "";
        texts.target3 = lang3 && lang3 !== "none" && translations && translations.length > 2 ? translations[2] || "" : "";

        updateSectionDisplay();
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
    function updateSectionDisplay() {
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
            if (span.textContent !== texts[key]) {
                span.textContent = texts[key];
                span.setAttribute("data-stroke", texts[key]);
                // 強制重繪以確保偽元素更新
                span.style.display = 'inline-block';
                span.offsetHeight; // 觸發重排
                span.style.display = '';
            }
        });

        if (DEBUG) {
            console.info("[SpeechAndTranslation] Updated UI spans:", {
                source: { text: spans.source.textContent, stroke: spans.source.getAttribute("data-stroke") },
                target1: { text: spans.target1.textContent, stroke: spans.target1.getAttribute("data-stroke") },
                target2: { text: spans.target2.textContent, stroke: spans.target2.getAttribute("data-stroke") },
                target3: { text: spans.target3.textContent, stroke: spans.target3.getAttribute("data-stroke") }
            });
        }
        console.info("[SpeechAndTranslation] UI updated.");
    }

    // ==========================================================================
    // 事件綁定
    // ==========================================================================
    console.info("[SpeechAndTranslation] Binding event listeners.");
    elements.startSpeechButton.addEventListener("click", () => {
        console.info("[SpeechAndTranslation] Start button clicked.");
        if (window.SpeechRecognitionAPI.start()) {
            elements.startSpeechButton.disabled = true;
            elements.stopSpeechButton.disabled = false;
            elements.startSpeechButton.classList.add("pressed");
            setTimeout(() => elements.startSpeechButton.classList.remove("pressed"), 200);
        }
    }, { capture: true });

    elements.stopSpeechButton.addEventListener("click", () => {
        console.info("[SpeechAndTranslation] Stop button clicked.");
        if (window.SpeechRecognitionAPI.stop()) {
            elements.startSpeechButton.disabled = false;
            elements.stopSpeechButton.disabled = true;
            elements.stopSpeechButton.classList.add("pressed");
            setTimeout(() => elements.stopSpeechButton.classList.remove("pressed"), 200);
        }
    }, { capture: true });

    elements.sourceLanguageSelect.addEventListener("change", () => {
        recognition.lang = elements.sourceLanguageSelect.value;
        console.info("[SpeechAndTranslation] Source language updated to:", recognition.lang);
    });

    [elements.targetLanguage1Select, elements.targetLanguage2Select, elements.targetLanguage3Select].forEach((select, index) => {
        select.addEventListener("change", () => {
            const langKey = `target${index + 1}`;
            if (select.value === "none") {
                texts[langKey] = "";
                updateSectionDisplay();
                console.info(`[SpeechAndTranslation] Cleared ${langKey} due to 'none' selection.`);
            }
        });
    });
});
