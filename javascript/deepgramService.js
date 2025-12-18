// deepgramService.js
// 職責：管理 Deepgram WebSocket 連線與音訊串流
// 依賴：config.js (取得設定), translationController.js (發送結果)

import { setRecognitionControlsState, clearAllTextElements, } from "./speechCapture.js";
import { sendTranslationRequest, updateStatusDisplay, } from "./translationController.js"; // [修改] 引入 updateStatusDisplay 用於通知
import { getDeepgramCode } from "./config.js";
import { Logger } from "./logger.js";

let socket = null;
let mediaRecorder = null;
let isRunning = false;
let keepAliveInterval = null;
let finalTranscriptBuffer = "";

let deepgramKeywordConfig = null;
let deepgramPreviousText = null;

// === [設定區] ===

// Nova-3 支援的語言白名單
const NOVA3_SUPPORTED_LANGS = [ "en", "ja", "ko", "es", "fr", "de", "it", "pt", "nl", "id", "vi", "ru", "uk", "pl", "hi", "tr", ];
// 支援 Code Switching (Multi模式) 的語言
//const MULTI_SUPPORTED_LANGS = ["en", "es", "ko"];
const MULTI_SUPPORTED_LANGS = ['ja', 'en', 'es', 'ko'];

// [新增] 自動停止設定
const AUTO_STOP_TIMEOUT = 10 * 60 * 1000; // 10 分鐘無語音則自動停止
let lastSpeechTime = 0; // 最後一次偵測到語音的時間
let watchdogInterval = null; // 看門狗計時器

// =================

// 取得後端提供的 API Key
async function fetchDeepgramKey() {
  try {
    const linkInput = document.getElementById("translation-link");
    if (!linkInput) throw new Error("找不到 translation-link 元素");

    let rawInput = linkInput.value.trim();
    if (!rawInput) {
      Logger.warn("[WARN]", "[DeepgramService]", "未輸入後端網址");
      return null;
    }

    let serviceHost = rawInput;
    const urlPattern = /^\s*(\w+):\/\/(.+)$/;
    const match = rawInput.match(urlPattern);
    if (match) { serviceHost = match[2]; }

    let protocol = "https";
    if (serviceHost.startsWith("localhost:8083")) { protocol = "http"; }

    let tempUrlStr = `${protocol}://${serviceHost}`;
    let urlObj;
    try {
      urlObj = new URL(tempUrlStr);
    } catch (e) {
      Logger.warn("[WARN]", "[DeepgramService]", "URL 解析微調", tempUrlStr);
      urlObj = new URL(tempUrlStr + "/");
    }

    const tokenUrl = `${urlObj.origin}/deepgram/token`;
    // Logger.debug('[DEBUG]', '[DeepgramService]', `解析後的 Token 請求位址: ${tokenUrl}`);

    const response = await fetch(tokenUrl);
    if (!response.ok)
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);

    const data = await response.json();
    if (!data.key) return null;

    // === [前端補刀] 再次確保去除了空白 ===
    const finalKey = data.key.trim();

    return finalKey;
  } catch (error) {
    Logger.error("[ERROR]", "[DeepgramService]", "取得 Key 失敗", error);
    return null;
  }
}

// 載入 Deepgram 專用關鍵字
async function loadDeepgramKeywords() {
  if (deepgramKeywordConfig) return deepgramKeywordConfig;

  try {
    const response = await fetch("data/deepgram_keywords.json");
    if (!response.ok) {
      Logger.warn("[WARN]", "[DeepgramService]", "無法讀取 deepgram_keywords.json，將不使用增強關鍵字");
      return {};
    }
    deepgramKeywordConfig = await response.json();
    Logger.info("[INFO]", "[DeepgramService]", "Deepgram 關鍵字設定已載入");
    return deepgramKeywordConfig;
  } catch (error) {
    Logger.error("[ERROR]", "[DeepgramService]", "載入關鍵字設定失敗", error);
    return {};
  }
}

/**
 * 清除日文/漢字之間的半形空格
 */
function removeJapaneseSpaces(text) {
  if (!text) return "";

  const jpChar =
    "\\u3000-\\u303f\\u3040-\\u309f\\u30a0-\\u30ff\\uff00-\\uff9f\\u4e00-\\u9faf";
  const pattern = new RegExp(`([${jpChar}])\\s+([${jpChar}])`, "g");

  let current = text;
  let previous;

  do {
    previous = current;
    current = current.replace(pattern, "$1$2");
  } while (current !== previous);

  return current;
}

/**
 * 緩衝區清洗函式
 */
function flushBuffer(langCode) {
  if (!finalTranscriptBuffer || finalTranscriptBuffer.trim().length === 0) {
    return;
  }

  const cleanText = finalTranscriptBuffer.replace(/[、。？,\.]/g, " ");

  if (cleanText.replace(/^ +$/, "").length > 0) {
    Logger.info("[INFO]", "[DeepgramService]", "語句結束，發送翻譯緩衝區:", cleanText);
    // sendTranslationRequest(cleanText, deepgramPreviousText, langCode);
    sendTranslationRequest(cleanText, null, langCode); //因為deepgram的字處理方式和web speech api有一點不同所以先不用上文

    deepgramPreviousText = cleanText;
  }

  finalTranscriptBuffer = "";
}

/**
 * 啟動 Deepgram 服務
 */
export async function startDeepgram(langCode, onTranscriptUpdate) {
  if (isRunning) return;

  finalTranscriptBuffer = "";

  // 重置看門狗計時
  lastSpeechTime = Date.now();

  const apiKey = await fetchDeepgramKey();
  if (!apiKey) {
    Logger.warn("[WARN]", "[DeepgramService]", "無法取得 API Key，將退回 Web Speech API");
    updateStatusDisplay("Deepgram Key 取得失敗、Web Speech API へ切り替えます..."); 
    return false; 
  }

  const keywordConfig = await loadDeepgramKeywords();

  try {
    // === [修改] 增強音訊處理參數 ===
    const audioConstraints = {

      // 訊號處理 (針對高噪音環境)
      echoCancellation: true, // 回音消除 (建議開啟)
      noiseSuppression: true, // 降噪 (務必開啟)

      // 自動增益 (AGC)
      // 如果發現背景噪音在你不講話時會忽大忽小，請嘗試改成 false
      autoGainControl: true,
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false, });

    // === 語言與模型判斷邏輯 ===
    let deepgramLang = getDeepgramCode(langCode);
    let selectedModel = "nova-2";

    if (NOVA3_SUPPORTED_LANGS.includes(deepgramLang)) {
      selectedModel = "nova-3";
    }

    let finalLangParam = deepgramLang;
    if (MULTI_SUPPORTED_LANGS.includes(deepgramLang)) {
      Logger.info("[INFO]", "[DeepgramService]", `語言 ${deepgramLang} 支援 Code Switching，切換至 multi 模式`);
      finalLangParam = "multi";
    } else {
      Logger.info("[INFO]", "[DeepgramService]", `語言 ${deepgramLang} 使用專用模型模式`);
    }

    Logger.info("[INFO]", "[DeepgramService]", `啟動參數: Model=${selectedModel}, Lang=${finalLangParam}`);
    // ===========================

    const baseUrl = "wss://api.deepgram.com/v1/listen";
    const params = new URLSearchParams({
      model: selectedModel,
      language: finalLangParam,
      smart_format: "true",
      interim_results: "true",
      utterance_end_ms: "1000",
      endpointing: "false",
      vad_events: "true", // 必須開啟，用於偵測語音活動
      diarize: "false",
    });

    // === [新增] 注入關鍵字邏輯 ===
    // 1. 加入全域關鍵字
    // 判斷是否為 Nova-3 模型
    const isNova3 = selectedModel.includes("nova-3");

    // 定義要使用的參數名稱 (Nova-3 用 keyterm, 舊版用 keywords)
    const paramName = isNova3 ? "keyterm" : "keywords";

    // 輔助函式：處理關鍵字格式
    const addKeyword = (item) => {
      if (isNova3) {
        // Nova-3: 僅支援純文字，移除權重 (例如 "Hamham:10" -> "Hamham")
        // 且 Nova-3 支援短語 (包含空格)，所以直接傳入 word 即可
        params.append(paramName, item.word);
      } else {
        // Nova-2: 維持 "單字:權重" 格式
        // Nova-2 不支援空格，若有空格通常建議拆開或不使用，但這裡先照傳
        params.append(paramName, `${item.word}:${item.boost}`);
      }
    };

    // 1. 加入全域關鍵字
    if (keywordConfig.global) {
      keywordConfig.global.forEach((item) => addKeyword(item));
    }

    // 2. 加入特定語言關鍵字
    if (keywordConfig[deepgramLang]) {
      keywordConfig[deepgramLang].forEach((item) => addKeyword(item));
    }

    // 記錄一下 (方便除錯)
    const keywordsCount = params.getAll(paramName).length;
    Logger.info("[INFO]", "[DeepgramService]", `已載入 ${keywordsCount} 個強化關鍵字 (Model: ${selectedModel}, Param: ${paramName})`);

    // ===========================

    socket = new WebSocket(`${baseUrl}?${params.toString()}`, [ "token", apiKey, ]);

    socket.onopen = () => {
      Logger.info("[INFO]", "[DeepgramService]", `Deepgram 連線已建立`);
      isRunning = true;
      updateStatusDisplay("Deepgram 接続成功 (待機中...)"); // UI 提示

      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0 && socket && socket.readyState === 1) {
          socket.send(event.data);
        }
      });

      mediaRecorder.start(100);

      // KeepAlive (每 3 秒)
      keepAliveInterval = setInterval(() => {
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 3000);

      // [新增] 啟動看門狗 (每 10 秒檢查一次)
      watchdogInterval = setInterval(() => {
        const idleTime = Date.now() - lastSpeechTime;
        if (idleTime > AUTO_STOP_TIMEOUT) {
          Logger.warn("[WARN]", "[DeepgramService]", `超過 ${  AUTO_STOP_TIMEOUT / 1000 } 秒未偵測到語音，自動斷線以節省費用。`);
          stopDeepgram();
          updateStatusDisplay("⚠️ 長時間無音のため、自動的に切断しました (コスト節約)。");
          //alert("長時間音声を検知しなかったため、Deepgramを自動停止しました。\n(自動停止：10分)");
        }
      }, 10000);
    };

    socket.onmessage = (message) => {
      try {
        const received = JSON.parse(message.data);

        // [新增] 看門狗重置邏輯：只要有語音活動 (SpeechStarted) 或 有文字產生，就重置計時器
        // SpeechStarted 比 transcript 更靈敏，只要有人出聲就算，不用等字出來
        if (
          received.type === "SpeechStarted" ||
          (received.channel && received.channel.alternatives?.[0]?.transcript)
        ) {
          lastSpeechTime = Date.now();
        }

        if (received.type === "UtteranceEnd") {
          // Logger.debug('[DEBUG]', '[DeepgramService]', '收到斷句訊號');
          flushBuffer(langCode);
          return;
        }

        if (!received.channel) return;

        let transcript = received.channel.alternatives?.[0]?.transcript;
        const isFinal = received.is_final;

        if (transcript && transcript.trim().length > 0) {
          transcript = removeJapaneseSpaces(transcript);

          if (isFinal) {
            const isCJK = ["ja", "zh-TW", "zh-HK", "ko", "th"].includes(
              deepgramLang
            );
            if (isCJK) { finalTranscriptBuffer += transcript; }
            else       { finalTranscriptBuffer += (finalTranscriptBuffer ? " " : "") + transcript;}

            // Logger.debug('[DEBUG]', '[DeepgramService]', '緩衝區:', finalTranscriptBuffer);
            if (onTranscriptUpdate) onTranscriptUpdate(finalTranscriptBuffer, true);
          } else {
            const displayTemp = finalTranscriptBuffer + transcript;
            if (onTranscriptUpdate) onTranscriptUpdate(displayTemp, false);
          }
        }
      } catch (parseError) {
        Logger.error("[ERROR]", "[DeepgramService]", "解析訊息失敗", parseError);
      }
    };

    socket.onclose = () => {
      Logger.info("[INFO]", "[DeepgramService]", "Deepgram 連線已關閉");
      stopDeepgram();
    };

    socket.onerror = (error) => {
      Logger.error("[ERROR]", "[DeepgramService]", "Deepgram Socket 錯誤", error);
      updateStatusDisplay("Deepgram 連線錯誤，請檢查後端或網路");
    };
  } catch (error) {
    Logger.error("[ERROR]", "[DeepgramService]", "啟動失敗", error);
    stopDeepgram();
    return false;
  }

  return true;
}

export function stopDeepgram() {
  isRunning = false;

  // 清除計時器
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  // 停止錄音與軌道
  if (mediaRecorder) {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    }
    mediaRecorder = null;
  }

  // 停止 Socket
  if (socket) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    socket.close();
    socket = null;
  }

  finalTranscriptBuffer = "";
  Logger.info("[INFO]", "[DeepgramService]", "Deepgram 服務已完全停止");

  setRecognitionControlsState(false); //調用開關函式切換到停止狀態
  clearAllTextElements();
}
