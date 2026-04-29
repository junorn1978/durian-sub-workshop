/**
 * @file deepgramService.js
 * @description 管理 Deepgram WebSocket 連線與音訊串流。
 * 
 */

import { getLang } from "./config.js";
import { isDebugEnabled } from "./logger.js";

const DEFAULT_LIFECYCLE_HANDLERS = {
  onStatusChange: () => {},
  onStop: () => {}
};

// #region [全域狀態變數]
let socket = null;
let isRunning = false;
let keepAliveInterval = null;
let watchdogInterval = null;
let lastSpeechTime = 0;
let sentenceBuffer = "";
let currentInterimTranscript = "";
let finalResultCount = 0;
let globalStream = null;
let globalOnTranscriptUpdate = null;

// Audio Context 相關變數
let audioContext = null;
let mediaStreamSource = null;
let audioWorkletNode = null;

let deepgramKeywordConfig = null;

let isIntentionalStop = false; // 標記是否為使用者主動停止
let retryCount = 0;
let lifecycleHandlers = { ...DEFAULT_LIFECYCLE_HANDLERS };
const MAX_RETRIES = 10;

// #endregion

// #region [設定與配置]
const NOVA3_SUPPORTED_LANGS = [ "en", "ja", "ko", "es", "fr", "de", "it", "pt", "nl", "id", "vi", "ru", "uk", "pl", "hi", "tr", "zh-TW", "zh-HK", "zh-CN" ];
const MULTI_SUPPORTED_LANGS = [ 'en', 'es', 'ko' ];
const AUTO_STOP_TIMEOUT = 8 * 60 * 1000; 

// AudioWorklet 處理器代碼
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // 接收主線程計算好的最佳 Buffer Size，預設 2048 以防萬一
    const bs = options?.processorOptions?.bufferSize;
    this.bufferSize = Number.isFinite(bs) ? bs : 2048;
    
    // 預先配置 Float32 緩衝區 (重複使用，不產生 GC)
    this.buffer = new Float32Array(this.bufferSize);
    this.index = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    
    const inputChannel = input[0];
    const inputLength = inputChannel.length;

    for (let i = 0; i < inputLength; i++) {
      this.buffer[this.index++] = inputChannel[i];
      if (this.index >= this.bufferSize) { this.flush(); }
    }
    return true;
  }

  flush() {
    const int16Data = new Int16Array(this.bufferSize);

    for (let i = 0; i < this.bufferSize; i++) {
      const s = this.buffer[i];
      
      // Hard Clipping (-1.0 ~ 1.0)
      const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
      
      // Convert to Int16 (Little Endian for PC/Mac)
      int16Data[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7FFF;
    }

    this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
    this.index = 0;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;
// #endregion

// #region [內部工具與輔助函式]

async function fetchDeepgramTemporaryToken() {
  try {
    const linkInput = document.getElementById("translation-link");
    if (!linkInput) throw new Error("找不到 translation-link 元素");

    const rawInput = linkInput.value.trim();
    if (!rawInput) return null;

    let serviceUrl = rawInput;
    let serviceApiKey = "";

    const protocolMatch = rawInput.match(/^([a-zA-Z0-9-]+):\/\/(.+)$/);
    if (protocolMatch) {
      const scheme = protocolMatch[1].toLowerCase();
      if (scheme !== "http" && scheme !== "https") {
        serviceApiKey = protocolMatch[1].trim();
        serviceUrl = protocolMatch[2].trim();
      }
    }

    if (!/^https?:\/\//i.test(serviceUrl)) {
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(serviceUrl);
      serviceUrl = `${isLocal ? "http" : "https"}://${serviceUrl.replace(/^\/+/, "")}`;
    }

    const serviceBaseUrl = new URL(serviceUrl.replace(/\/+$/, ""));
    const tokenUrl = new URL("/deepgram/token", serviceBaseUrl).toString();
    const response = await fetch(tokenUrl, {
      headers: serviceApiKey ? { "x-api-key": serviceApiKey } : {}
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} - ${await response.text()}`);

    const data = await response.json();
    const temporaryToken = [data.key, data.token, data.access_token].find(
      (value) => typeof value === "string" && value.trim()
    );
    if (!temporaryToken) return null;

    const normalizedType = String(data.tokenType || data.token_type || "").toLowerCase();
    const protocol = normalizedType === "jwt" || normalizedType === "bearer" || temporaryToken.includes(".")
      ? "bearer"
      : "token";

    return {
      value: temporaryToken.trim(),
      protocol
    };
  } catch (error) {
    if (isDebugEnabled()) console.error("[ERROR]", "[DeepgramService]", "取得臨時 Token 失敗", error);
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

function setLifecycleHandlers(handlers = {}) {
  lifecycleHandlers = { ...DEFAULT_LIFECYCLE_HANDLERS, ...handlers };
}

function notifyStatusChange(text, details = null) {
  lifecycleHandlers.onStatusChange(text, details);
}

function notifyStopped(reason, intentional) {
  lifecycleHandlers.onStop({ reason, intentional });
}
// #endregion

// #region [核心服務控制]

function resetSentenceBuffer() {
  sentenceBuffer = "";
  currentInterimTranscript = "";
  finalResultCount = 0;
}

function flushSentenceBuffer(onTranscriptUpdate, reason) {
  const textToFlush = sentenceBuffer.trim();
  if (textToFlush.length === 0) return false;

  if (isDebugEnabled()) console.info("[INFO]", "[DeepgramService]", `${reason} 觸發斷句 (僅 Final)`);
  if (onTranscriptUpdate && textToFlush !== '？' && textToFlush !== '。' && textToFlush !== '、') {
    onTranscriptUpdate(textToFlush, true, true);
  }

  resetSentenceBuffer();
  return true;
}

function cleanupAudioResources(options = {}) {
  const keepStream = options.keepStream === true;

  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (watchdogInterval)  { clearInterval(watchdogInterval); watchdogInterval = null; }

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
    audioContext.close().catch(err => { if (isDebugEnabled()) console.error("AudioContext 關閉失敗", err); });
    audioContext = null;
  }

  if (!keepStream && globalStream) {
    globalStream.getTracks().forEach(track => {
      track.stop();
    });
    globalStream = null;
  }

  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    socket = null;
  }
}

/**
 * 啟動 Deepgram 語音辨識服務 (AudioWorklet 版)
 */
export async function startDeepgram(langId, onTranscriptUpdate, handlers = {}) {
  setLifecycleHandlers(handlers);
  globalOnTranscriptUpdate = onTranscriptUpdate;
  if (isRunning) return true;

  notifyStatusChange('接続中。しばらくお待ちください...');
  const langObj = getLang(langId);
  if (!langObj) {
    if (isDebugEnabled()) console.error("[ERROR] [Deepgram] 找不到語系定義:", langId);
    return false;
  }

  lastSpeechTime = Date.now();

  const authInfo = await fetchDeepgramTemporaryToken();
  if (!authInfo?.value) {
    notifyStatusChange("Deepgram 臨時 Token 取得失敗、Web Speech API へ切り替えます..."); 
    return false; 
  }

  const keywordConfig = await loadDeepgramKeywords();

  isIntentionalStop = false;
  if (!retryCount) retryCount = 0;

  try {
    // 重連時可重用已存在的麥克風 stream，減少音訊缺口
    const isStreamAlive = globalStream && globalStream.getAudioTracks().some(t => t.readyState === 'live');
    if (!isStreamAlive) {
      if (globalStream) {
        globalStream.getTracks().forEach(t => t.stop());
        globalStream = null;
      }
      globalStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl:  true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false
      });
    }

    const track = globalStream.getAudioTracks()[0];
    const settings = track.getSettings();

    if (isDebugEnabled()) console.info("[INFO] [Microphone] 麥克風實際生效參數:", {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      voiceIsolation: settings.voiceIsolation,
      latency: settings.latency,
      deviceId: settings.deviceId,
    });

    // 嘗試建立 16000Hz 的 AudioContext
    try {
        audioContext = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
        if (isDebugEnabled()) console.warn("[WARN]", "不支援指定採樣率，使用系統預設值", e);
        audioContext = new AudioContext();
    }
    const finalSampleRate = audioContext.sampleRate;
    if (isDebugEnabled()) console.info("[INFO]", "[AudioContext] 最終運作 SampleRate:", finalSampleRate);


    // 計算 Buffer Size (目標: 每 100ms 發送一次)
    const TARGET_CHUNK_SEC = 0.1; 
    let targetBufferSize = Math.round(finalSampleRate * TARGET_CHUNK_SEC);
    
    targetBufferSize = Math.max(256, Math.round(targetBufferSize / 256) * 256);
    if (isDebugEnabled()) console.info("[INFO]", "[AudioWorklet] 計算出的 Buffer Size:", targetBufferSize, `(約 ${(targetBufferSize/finalSampleRate*1000).toFixed(1)}ms)`);


    const blob = new Blob([PCM_PROCESSOR_CODE], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    await audioContext.audioWorklet.addModule(workletUrl);

    audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor', {
        processorOptions: { bufferSize: targetBufferSize }
    });

    // 立即建立音訊管線，在 WebSocket 連線前就開始收集 PCM 資料
    mediaStreamSource = audioContext.createMediaStreamSource(globalStream);

    const highpass = audioContext.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 90;
    highpass.Q.value = 0.707;

    const preGainNode = audioContext.createGain();
    preGainNode.gain.value = 1;

    mediaStreamSource.connect(highpass);
    highpass.connect(preGainNode);
    preGainNode.connect(audioWorkletNode);

    const pendingAudioChunks = [];

    audioWorkletNode.port.onmessage = (event) => {
      if (socket?.readyState === 1) {
        socket.send(event.data);
      } else {
        pendingAudioChunks.push(event.data);
      }
    };

    const deepgramCode = langObj.deepgramCode;
    let selectedModel = NOVA3_SUPPORTED_LANGS.includes(deepgramCode) ? "nova-3" : "nova-2";
    let finalLangParam = MULTI_SUPPORTED_LANGS.includes(deepgramCode) ? "multi" : deepgramCode;

    const params = new URLSearchParams({
      model: selectedModel,
      language: finalLangParam,
      smart_format:     "true",
      interim_results:  "true",
      utterance_end_ms: "1000",
      endpointing:      "350",
      vad_events:       "true",
      encoding:         "linear16",
      sample_rate:      finalSampleRate.toString()
    });

    const isNova3 = selectedModel.includes("nova-3");
    const paramName = isNova3 ? "keyterm" : "keywords";

    const addKeyword = (item) => {
      params.append(paramName, isNova3 ? item.word : `${item.word}:${item.boost}`);
    };

    if (keywordConfig.global) keywordConfig.global.forEach(addKeyword);
    if (keywordConfig[deepgramCode]) keywordConfig[deepgramCode].forEach(addKeyword);

    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [ authInfo.protocol, authInfo.value ]);

    socket.onopen = () => {
      isRunning = true;
      notifyStatusChange("Deepgram 接続成功 (Raw Audio Mode)");

      // 送出連線前暫存的音訊資料
      if (pendingAudioChunks.length > 0) {
        if (isDebugEnabled()) console.info("[INFO]", "[DeepgramService]", `送出 ${pendingAudioChunks.length} 個暫存音訊片段`);
        for (const chunk of pendingAudioChunks) {
          socket.send(chunk);
        }
        pendingAudioChunks.length = 0;
      }

      keepAliveInterval = setInterval(() => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "KeepAlive" }));
      }, 3000);

      watchdogInterval = setInterval(() => {
        if (Date.now() - lastSpeechTime > AUTO_STOP_TIMEOUT) {
          notifyStatusChange("⚠️ 長時間無音のため、自動的に切斷しました (成本節約)。");
          stopDeepgram({ intentional: false, reason: 'auto-timeout' });
        }
      }, 10000);
    };

    socket.onmessage = (message) => {
      try {
        const received = JSON.parse(message.data);

        if (received.type === "UtteranceEnd") {
          // 只 flush 已 finalize 的 sentenceBuffer，不動 currentInterimTranscript
          // 避免搶走下一句開頭的 interim 文字，減少視覺跳動
          flushSentenceBuffer(onTranscriptUpdate, "⚡ UtteranceEnd");

          // flush 後立即重新顯示殘留的 interim，避免 DOM 被清空後閃爍
          if (currentInterimTranscript.trim().length > 0 && onTranscriptUpdate) {
            onTranscriptUpdate(currentInterimTranscript, false, false);
          }
          return;
        }

        if (!received.channel) return;

        let transcript = received.channel.alternatives?.[0]?.transcript;

        if (transcript && transcript.trim().length > 0) {
          lastSpeechTime = Date.now();
          transcript = removeJapaneseSpaces(transcript);

          currentInterimTranscript = transcript;
          
          if (onTranscriptUpdate) { onTranscriptUpdate(sentenceBuffer + transcript, false, false); }

          if (received.is_final) {
            const isCJK = ["ja", "zh-TW", "zh-HK", "ko", "th"].includes(deepgramCode);
            sentenceBuffer += (isCJK || !sentenceBuffer) ? transcript : ` ${transcript}`;
            finalResultCount++;
            currentInterimTranscript = "";

            if (received.speech_final) {
              flushSentenceBuffer(onTranscriptUpdate, "⚡ speech_final");
            }
          }
        }
      } catch (e) {
        if (isDebugEnabled()) console.error("[ERROR]", "[DeepgramService]", "解析訊息失敗", e);
      }
    };

    socket.onclose = (event) => {
      if (isIntentionalStop) {
          notifyStatusChange('');
      } else {
          if (isDebugEnabled()) console.warn("[WARN] Deepgram 意外斷線，準備重連...");

          if (retryCount < MAX_RETRIES) {
              const delay = 800;
              retryCount++;
              notifyStatusChange(`接続が切断されました。再接続中...`);
              cleanupAudioResources({ keepStream: true });
              isRunning = false;
              setTimeout(() => {
                startDeepgram(langId, onTranscriptUpdate, lifecycleHandlers);
              }, delay);
          } else {
              notifyStatusChange("再接続に失敗しました。手動で再開してください。");
              stopDeepgram({ intentional: false, reason: 'retry-exhausted' });
          }
      }
    }
    socket.onerror = (e) => {
      if (isDebugEnabled()) console.error("[ERROR]", "[DeepgramService]", "Socket 錯誤", e);
      notifyStatusChange("Deepgram 接続エラー。バックエンドまたはネットワークを確認してください。");
    };
  } catch (error) {
    if (isDebugEnabled()) console.error("[ERROR]", "[DeepgramService]", "啟動失敗", error);
    stopDeepgram({ intentional: false, reason: 'startup-error' });
    return false;
  }
  return true;
}

export function stopDeepgram(options = {}) {
  const intentional = options.intentional !== false;
  const reason = options.reason || (intentional ? 'manual-stop' : 'service-stop');
  const hadSession =
    isRunning ||
    !!socket ||
    !!globalStream ||
    !!audioContext ||
    !!mediaStreamSource ||
    !!audioWorkletNode;

  // 停止前 flush 殘留文字，避免最後一段語音丟失
  const remainingText = (sentenceBuffer + currentInterimTranscript).trim();
  if (remainingText.length > 0 && globalOnTranscriptUpdate) {
    globalOnTranscriptUpdate(remainingText, true, true);
  }

  isRunning = false;
  isIntentionalStop = intentional;
  retryCount = 0;
  sentenceBuffer = '';
  currentInterimTranscript = '';
  finalResultCount = 0;
  lastSpeechTime = 0;
  globalOnTranscriptUpdate = null;

  // 嘗試發送關閉訊號給 Server (如果連線還在)
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: "CloseStream" }));
  }

  // 統一呼叫清理函式，確保硬體資源 (globalStream) 被正確釋放
  cleanupAudioResources();

  if (isDebugEnabled()) console.info("[INFO]", "[DeepgramService]", "Deepgram 服務已停止");

  if (intentional) {
    notifyStatusChange('');
  }

  if (hadSession) {
    notifyStopped(reason, intentional);
  }
}
// #endregion
