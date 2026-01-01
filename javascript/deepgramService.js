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
let finalResultCount = 0;

// Audio Context 相關變數 (取代 MediaRecorder)
let audioContext = null;
let mediaStreamSource = null;
let audioWorkletNode = null;

let finalTranscriptBuffer = "";
let deepgramKeywordConfig = null;

let isIntentionalStop = false; // 標記是否為使用者主動停止
let retryCount = 0;
const MAX_RETRIES = 10;

// #endregion

// #region [設定與配置]
const NOVA3_SUPPORTED_LANGS = [ "en", "ja", "ko", "es", "fr", "de", "it", "pt", "nl", "id", "vi", "ru", "uk", "pl", "hi", "tr" ];
const MULTI_SUPPORTED_LANGS = ['ja', 'en', 'es', 'ko'];
const AUTO_STOP_TIMEOUT = 8 * 60 * 1000; 

// AudioWorklet 處理器代碼 (內嵌以避免跨檔案載入問題)
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      // 取得單聲道數據
      const channelData = input[0];
      // 發送回主執行緒
      this.port.postMessage(channelData);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;
// #endregion

// #region [內部工具與輔助函式]

/**
 * 將 Float32 音訊數據轉換為 Int16 PCM 格式
 * @param {Float32Array} float32Array 
 * @returns {ArrayBuffer} Int16 ArrayBuffer
 */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    // 限制範圍在 -1 到 1 之間
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    // 轉換為 16-bit PCM (Little-endian)
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

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

// #region [核心服務控制]

/** * [修改] 內部工具：重置緩衝區
 * 不需要外部參數了，因為 logic 都在內部
 */
function resetSentenceBuffer() {
  sentenceBuffer = "";
  finalResultCount = 0;
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
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        /* 這些參數原則上瀏覽器都不吃，僅供參考 */
        echoCancellation: true, 
        noiseSuppression: true, 
        autoGainControl: true,
        channelCount: 1 // 強制單聲道，節省頻寬與處理量
      }, 
      video: false 
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
      smart_format: "true",
      interim_results: "true",
      utterance_end_ms: "1000",
      endpointing: "false",
      vad_events: "true",
      // 指定 Raw Audio 格式
      encoding: "linear16",
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

      mediaStreamSource = audioContext.createMediaStreamSource(stream);
      audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

      audioWorkletNode.port.onmessage = (event) => {
        if (socket?.readyState === 1) {
          // 將 Float32 轉為 Int16 並發送
          const pcmData = floatTo16BitPCM(event.data);
          socket.send(pcmData);
        }
      };

      mediaStreamSource.connect(audioWorkletNode);

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

        // 這是 Deepgram 判定使用者講完一句話（有停頓）的時機
        if (received.type === "UtteranceEnd") {
          lastSpeechTime = Date.now();
          if (sentenceBuffer.trim().length > 0) {
            // 收到斷句訊號 -> 呼叫 Callback -> 傳送目前的 Buffer -> 旗標 shouldTranslate = true
            if (onTranscriptUpdate) {
               onTranscriptUpdate(sentenceBuffer, true, true);
            }
            Logger.info("[INFO]", "[DeepgramService]", "UtteranceEnd 觸發翻譯", sentenceBuffer);
            resetSentenceBuffer();
          }
          return;
        }

        if (!received.channel) return;

        let transcript = received.channel.alternatives?.[0]?.transcript;
        
        if (transcript && transcript.trim().length > 0) {
          lastSpeechTime = Date.now();
          transcript = removeJapaneseSpaces(transcript);

          if (received.is_final) {
            const isCJK = ["ja", "zh-TW", "zh-HK", "ko", "th"].includes(deepgramCode);
            sentenceBuffer += (isCJK || !sentenceBuffer) ? transcript : ` ${transcript}`;
            finalResultCount++;

            //Logger.debug("[DEBUG]", "[DeepgramService]", finalResultCount, "個最終結果:", sentenceBuffer);
            const hasPunctuation = /[。？！.?!]$/.test(sentenceBuffer.trim());
            // 規則是finalResultCount >= n 最終結果之後，後一句是上述符號或字數大於language_config裡面的指定語系字數時發送翻譯和清空，否則累積顯示。
            // 字數大於language_config這邊可以視狀況調整，想短一點1倍，想留長一點就2-3倍或者乾脆拿掉。
            if (finalResultCount >= 2 && (hasPunctuation || sentenceBuffer.trim().length >= langObj.chunkSize)) {
              if (onTranscriptUpdate) { 
                  onTranscriptUpdate(sentenceBuffer, true, true); 
              }
              resetSentenceBuffer();
            } else {
              if (onTranscriptUpdate) { 
                  onTranscriptUpdate(sentenceBuffer, false, false); 
              }
            }
          } else {
            if (onTranscriptUpdate) { onTranscriptUpdate(sentenceBuffer + transcript, false, false); }
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
