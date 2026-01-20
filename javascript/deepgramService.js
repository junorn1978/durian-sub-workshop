/**
 * @file deepgramService.js
 * @description 管理 Deepgram WebSocket 連線與音訊串流。
 * 2025 優化版：捨棄 MediaRecorder，改用 AudioWorklet 傳送 Raw PCM 以達到極低延遲。
 */

import { setRecognitionControlsState, clearAllTextElements, } from "./speechCapture.js";
import { updateStatusDisplay, } from "./translationController.js";
import { getLang } from "./config.js";
import { Logger } from "./logger.js";

// #region [全域狀態變數]
let socket = null;
let isRunning = false;
let keepAliveInterval = null;
let watchdogInterval = null;
let lastSpeechTime = 0;
let sentenceBuffer = "";
let finalTranscriptBuffer = ""; // ide顯示沒有讀取但實際有使用的
let finalResultCount = 0;
let globalStream = null;

// Audio Context 相關變數 (取代 MediaRecorder)
let audioContext = null;
let mediaStreamSource = null;
let audioWorkletNode = null;

let deepgramKeywordConfig = null;

let isIntentionalStop = false; // 標記是否為使用者主動停止
let retryCount = 0;
const MAX_RETRIES = 10;

let speechFlushTimer = null;
const FLUSH_TIMEOUT_MS = 1100; // 沒有說話多久時間強制翻譯和清空逐字稿

// #endregion

// #region [設定與配置]
const NOVA3_SUPPORTED_LANGS = [ "en", "ja", "ko", "es", "fr", "de", "it", "pt", "nl", "id", "vi", "ru", "uk", "pl", "hi", "tr" ];
const MULTI_SUPPORTED_LANGS = [ 'ja', 'en', 'es', 'ko' ];
//const MULTI_SUPPORTED_LANGS = [ 'en', 'es', 'ko' ];
const AUTO_STOP_TIMEOUT = 8 * 60 * 1000; 

// AudioWorklet 處理器代碼 (內嵌以避免跨檔案載入問題)
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 設定緩衝區大小：2048 samples
    this.bufferSize = 2048; 
    
    // 預先配置 Float32 緩衝區 (重複使用，不產生 GC)
    this.buffer = new Float32Array(this.bufferSize);
    this.index = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    
    const inputChannel = input[0];
    const inputLength = inputChannel.length;

    // 1. 將進來的音訊數據抄寫到內部緩衝區
    // 這是一個極快的記憶體複製操作
    for (let i = 0; i < inputLength; i++) {
      this.buffer[this.index++] = inputChannel[i];

      // 2. 只有當緩衝區滿了，才進行轉換並發送
      if (this.index >= this.bufferSize) {
        this.flush();
      }
    }
    return true;
  }

  flush() {
    // 建立 Int16Array 準備傳送
    const int16Data = new Int16Array(this.bufferSize);

    for (let i = 0; i < this.bufferSize; i++) {
      const s = this.buffer[i];
      
      // Hard Clipping (-1.0 ~ 1.0)
      const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
      
      // Convert to Int16 (Little Endian for PC/Mac)
      int16Data[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7FFF;
    }

    // 3. 發送並移交擁有權 (Zero-Copy)
    this.port.postMessage(int16Data.buffer, [int16Data.buffer]);

    // 重置索引，繼續使用同一個 Float32Array
    this.index = 0;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;
// #endregion

// #region [內部工具與輔助函式]

async function fetchDeepgramKey() {
  try {
    const linkInput = document.getElementById("translation-link");
    if (!linkInput) throw new Error("找不到 translation-link 元素");

    let rawInput = linkInput.value.trim();
    if (!rawInput) return null;

    let serviceHost = rawInput;
    const protocolMatch = rawInput.match(/^(\w+):\/\/(.+)$/);
    if (protocolMatch) { serviceHost = protocolMatch[2]; }

    let protocol = serviceHost.startsWith("localhost:8083") ? "http" : "https";
    const urlObj = new URL(`${protocol}://${serviceHost.replace(/\/+$/, '')}`);
    const tokenUrl = `${urlObj.origin}/deepgram/token`;

    const response = await fetch(tokenUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    return data.key ? data.key.trim() : null;
  } catch (error) {
    Logger.error("[ERROR]", "[DeepgramService]", "取得 Key 失敗", error);
    return null;
  }
}

async function loadDeepgramKeywords() {
  if (deepgramKeywordConfig) return deepgramKeywordConfig;
  try {
    const response = await fetch("data/deepgram_keywords.json");
    if (!response.ok) return {};
    deepgramKeywordConfig = await response.json();
    return deepgramKeywordConfig;
  } catch (error) {
    return {};
  }
}

const JP_CHAR_RANGE = "\\u3000-\\u303f\\u3040-\\u309f\\u30a0-\\u30ff\\uff00-\\uff9f\\u4e00-\\u9faf";
const JP_SPACE_PATTERN = new RegExp(`([${JP_CHAR_RANGE}])\\s+([${JP_CHAR_RANGE}])`, "g");

function removeJapaneseSpaces(text) {
  if (!text) return "";
  let current = text;
  let previous;
  do {
    previous = current;
    current = current.replace(JP_SPACE_PATTERN, "$1$2");
  } while (current !== previous);
  return current;
}

/**
 * [新增] 觸發強制翻譯 (當靜默時間到達)
 */
function triggerForcedFlush(onTranscriptUpdate) {
  if (speechFlushTimer) {
    clearTimeout(speechFlushTimer);
    speechFlushTimer = null;
  }

  if (sentenceBuffer.trim().length > 0) {
    Logger.info("[INFO]", "[DeepgramService]", "⏳ 本地計時器觸發斷句翻譯", sentenceBuffer);
    if (onTranscriptUpdate) {
      // 強制標記為 complete = true
      onTranscriptUpdate(sentenceBuffer, true, true);
    }
    resetSentenceBuffer();
  }
}

/**
 * [新增] 重置靜默計時器
 * 每次收到任何文字更新時呼叫此函式
 */
function resetFlushTimer(onTranscriptUpdate, currentTranscript = "") {
  if (speechFlushTimer) {
    clearTimeout(speechFlushTimer);
    speechFlushTimer = null;
  }

  // 判斷：不管是「已存的 Buffer」還是「正在講的 Transcript」，只要有字，就要啟動斷句計時
  const hasPendingText = (sentenceBuffer + currentTranscript).trim().length > 0;

  if (hasPendingText) {
    speechFlushTimer = setTimeout(() => {
      triggerForcedFlush(onTranscriptUpdate);
    }, FLUSH_TIMEOUT_MS);
  }
}
// #endregion

// #region [核心服務控制]

/** * [修改] 內部工具：重置緩衝區
 * 不需要外部參數了，因為 logic 都在內部
 */
function resetSentenceBuffer() {
  sentenceBuffer = "";
  finalResultCount = 0;
  if (speechFlushTimer) { clearTimeout(speechFlushTimer); speechFlushTimer = null; }
}

/**
 * 獨立的音訊資源清理函式
 * 用於斷線重連時，只清理音訊與Socket，而不重置UI狀態
 */
function cleanupAudioResources() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (watchdogInterval)  { clearInterval(watchdogInterval); watchdogInterval = null; }

  // 停止並釋放 AudioContext 資源
  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }
  
  if (audioWorkletNode) {
    audioWorkletNode.port.onmessage = null;
    audioWorkletNode.disconnect();
    audioWorkletNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(err => Logger.error("AudioContext 關閉失敗", err));
    audioContext = null;
  }

  // 關閉 WebSocket 連線  
  if (socket) {
    // 避免在重連時發送 CloseStream 導致邏輯衝突，直接關閉即可
    if (socket.readyState === 1) {
       // 只有在完全停止時才發送 Close 訊號，重連時可不發
       // socket.send(JSON.stringify({ type: "CloseStream" })); 
    }
    socket.onclose = null; // 移除監聽，避免遞迴觸發
    socket.onerror = null;
    socket.close();
    socket = null;
  }
}

/**
 * 啟動 Deepgram 語音辨識服務 (AudioWorklet 版)
 * @async
 * @param {string} langId - 語系唯一 ID (例如 'ja-JP')
 * @param {Function} onTranscriptUpdate - 文字更新回呼
 */
export async function startDeepgram(langId, onTranscriptUpdate) {
  if (isRunning) return true;

  updateStatusDisplay('接続中。しばらくお待ちください...');
  const langObj = getLang(langId);
  if (!langObj) {
    Logger.error("[ERROR] [Deepgram] 找不到語系定義:", langId);
    return false;
  }

  finalTranscriptBuffer = "";
  lastSpeechTime = Date.now();

  const apiKey = await fetchDeepgramKey();
  if (!apiKey) {
    updateStatusDisplay("Deepgram Key 取得失敗、Web Speech API へ切り替えます..."); 
    return false; 
  }

  const keywordConfig = await loadDeepgramKeywords();

  isIntentionalStop = false; // 啟動時重置標記
  retryCount = 0;            // 重置重試次數

  try {
    globalStream = await navigator.mediaDevices.getUserMedia({
      audio: { 
        /* 這些參數瀏覽器不一定會採用，僅供參考 */
        autoGainControl:  false,
        echoCancellation: false,
        noiseSuppression: false,
        samplerate: 16000,
        //channelCount: 1 // 單聲道，大部分狀況無效
      }, 
      video: false 
    });

    const track = globalStream.getAudioTracks()[0];
    const settings = track.getSettings();

    //const constraints = track.getConstraints();
    //Logger.debug("[DEBUG] [Microphone] 原始請求限制:", constraints);

    Logger.info("[INFO] [Microphone] 麥克風實際生效參數:", {
      echoCancellation: settings.echoCancellation, // 回音消除
      noiseSuppression: settings.noiseSuppression, // 降噪
      autoGainControl: settings.autoGainControl,   // 自動增益
      sampleRate: settings.sampleRate,             // 採樣率
      channelCount: settings.channelCount,         // 聲道數
      voiceIsolation: settings.voiceIsolation,     // 語音分離
      latency: settings.latency,                   // 延遲
      deviceId: settings.deviceId,                 // 裝置 ID
    });

    audioContext = new AudioContext();
    const sampleRate = audioContext.sampleRate; // 取得系統當前採樣率

    const blob = new Blob([PCM_PROCESSOR_CODE], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    await audioContext.audioWorklet.addModule(workletUrl);

    const deepgramCode = langObj.deepgramCode;
    let selectedModel = NOVA3_SUPPORTED_LANGS.includes(deepgramCode) ? "nova-3" : "nova-2";
    let finalLangParam = MULTI_SUPPORTED_LANGS.includes(deepgramCode) ? "multi" : deepgramCode;

    const params = new URLSearchParams({
      model: selectedModel,
      language: finalLangParam,
      smart_format:     "true",
      interim_results:  "true",
      utterance_end_ms: "1000",
      endpointing:      "false",
      vad_events:       "true",
      encoding:         "linear16", // 指定 Raw Audio 格式
      sample_rate: sampleRate.toString()
    });

    const isNova3 = selectedModel.includes("nova-3");
    const paramName = isNova3 ? "keyterm" : "keywords";

    const addKeyword = (item) => {
      params.append(paramName, isNova3 ? item.word : `${item.word}:${item.boost}`);
    };

    if (keywordConfig.global) keywordConfig.global.forEach(addKeyword);
    if (keywordConfig[deepgramCode]) keywordConfig[deepgramCode].forEach(addKeyword);

    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [ "token", apiKey ]);

    socket.onopen = () => {
      isRunning = true;
      updateStatusDisplay("Deepgram 接続成功 (Raw Audio Mode)");

      mediaStreamSource = audioContext.createMediaStreamSource(globalStream);

      const compressor = audioContext.createDynamicsCompressor();
            compressor.threshold.value = -20; // 超過 -20dB 就開始壓縮
            compressor.knee.value = 30;       // 平滑過渡
            compressor.ratio.value = 6;       // 壓縮比 12:1 (接近 Limiter，強力壓制大音量)(微調改6看多人說話效果有沒有好一點)
            compressor.attack.value = 0.003;  // 反應時間：快 (3ms)
            compressor.release.value = 0.25;  // 釋放時間：中 (250ms)

      const preGainNode = audioContext.createGain();
      preGainNode.gain.value = 3; // 將音量放大X倍 (可視情況調整 1.5 ~ 3.0)

      audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

      // 連接路徑： Source -> Gain -> Compressor -> Worklet
      mediaStreamSource.connect(preGainNode);
      preGainNode.connect(compressor);
      compressor.connect(audioWorkletNode);

      // 監聽 Worklet 傳回來的資料
      audioWorkletNode.port.onmessage = (event) => {
        if (socket?.readyState === 1) {
          socket.send(event.data);
        }
      };

      // 心跳機制
      keepAliveInterval = setInterval(() => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "KeepAlive" }));
      }, 3000);

      // 看門狗機制
      watchdogInterval = setInterval(() => {
        if (Date.now() - lastSpeechTime > AUTO_STOP_TIMEOUT) {
          stopDeepgram();
          updateStatusDisplay("⚠️ 長時間無音のため、自動的に切斷しました (成本節約)。");
        }
      }, 10000);
    };

    socket.onmessage = (message) => {
      try {
        const received = JSON.parse(message.data);

        if (received.type === "UtteranceEnd") {
          const currentBuffer = sentenceBuffer.trim();

          if (currentBuffer.length > 0) {
            Logger.info("[INFO]", "[DeepgramService]", "⚡ UtteranceEnd 觸發斷句 (AI)");
            triggerForcedFlush(onTranscriptUpdate);
          }
          return; // 處理完畢，直接結束這回合
        }

        if (!received.channel) return;

        let transcript = received.channel.alternatives?.[0]?.transcript;

        if (transcript && transcript.trim().length > 0) {
          lastSpeechTime = Date.now();
          transcript = removeJapaneseSpaces(transcript);

          if (received.is_final) {
            // deepgram對於日文和中文的辨識可能會有空格產生的狀態，這一段將空白去除
            const isCJK = ["ja", "zh-TW", "zh-HK", "ko", "th"].includes(deepgramCode);
            sentenceBuffer += (isCJK || !sentenceBuffer) ? transcript : ` ${transcript}`;
            finalResultCount++;

            // 產生最終結果的時候判斷要不要發送翻譯
            const currentBuffer = sentenceBuffer.trim();
            const hasPunctuation = /[。？！.?!]$/.test(currentBuffer);
            const isLengthExceeded = currentBuffer.length >= langObj.chunkSize * 2;

            if (finalResultCount >= 1 && (hasPunctuation || isLengthExceeded)) {
              // 滿足條件：送出翻譯
              if (onTranscriptUpdate) {
                onTranscriptUpdate(sentenceBuffer, true, true); 
              }
              resetSentenceBuffer();
            } else {
              // 未滿足條件：僅更新顯示
              if (onTranscriptUpdate) {
                  onTranscriptUpdate(sentenceBuffer, false, false); 
                  resetFlushTimer(onTranscriptUpdate, "");
              }
            }
          } else {
            // Interim Results
            if (onTranscriptUpdate) { 
              onTranscriptUpdate(sentenceBuffer + transcript, false, false); 
            }
            resetFlushTimer(onTranscriptUpdate, transcript);
          }
        }
      } catch (e) {
        Logger.error("[ERROR]", "[DeepgramService]", "解析訊息失敗", e);
      }
    };

    socket.onclose = (event) => {
      if (isIntentionalStop) {
          stopDeepgram();
          updateStatusDisplay('');
      } else {
          Logger.warn("[WARN] Deepgram 意外斷線，準備重連...");

          if (retryCount < MAX_RETRIES) {
              const delay = Math.min(500 * (2 ** retryCount), 5000); // 避免高速重新連線
              retryCount++;
              updateStatusDisplay(`接続が切断されました。${delay/500}秒後に再接続します...`);
              cleanupAudioResources(); // 需將 stopDeepgram 中的資源清理邏輯拆分出來
              setTimeout(() => {
                startDeepgram(langId, onTranscriptUpdate);
              }, delay);
          } else {
              updateStatusDisplay("再接続に失敗しました。手動で再開してください。");
              stopDeepgram();
          }
      }
    }
    socket.onerror = (e) => {
      Logger.error("[ERROR]", "[DeepgramService]", "Socket 錯誤", e);
      updateStatusDisplay("Deepgram 接続エラー。バックエンドまたはネットワークを確認してください。");
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
  isIntentionalStop = true;

  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (watchdogInterval)  { clearInterval(watchdogInterval);  watchdogInterval  = null; }
  if (speechFlushTimer)  { clearTimeout(speechFlushTimer);   speechFlushTimer  = null; }

  // 停止並釋放 AudioContext 資源
  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }

  if (audioWorkletNode) {
    audioWorkletNode.port.onmessage = null;
    audioWorkletNode.disconnect();
    audioWorkletNode = null;
  }

  if (audioContext) {
    // 關閉 context
    audioContext.close().catch(err => Logger.error("AudioContext 關閉失敗", err));
    audioContext = null;
  }
  // 關閉 WebSocket 連線  
  if (socket) {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "CloseStream" }));
    socket.close();
    socket = null;
  }

  finalTranscriptBuffer = "";
  Logger.info("[INFO]", "[DeepgramService]", "Deepgram 服務已停止");

  setRecognitionControlsState(false);
  clearAllTextElements();
}
// #endregion