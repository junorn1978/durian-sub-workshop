/**
 * @file sonioxService.js
 * @description 管理 Soniox WebSocket 連線與音訊串流。
 *
 * Deepgram と異なる点：
 * - 認証は接続後の最初の JSON メッセージで api_key を送る (sub-protocol ではない)。
 * - 結果は token 単位で返る。is_final=true は確定、false は仮 (次のメッセージで置換され得る)。
 * - エンドポイント検出は <end> トークンとして配信される。
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
let watchdogInterval = null;
let lastSpeechTime = 0;

// Soniox token-based 累積バッファ
let finalizedText = "";        // is_final=true のトークン連結 (append-only)
let nonFinalizedText = "";     // 各メッセージごとに置換される interim 部分

let globalStream = null;
let globalOnTranscriptUpdate = null;

// Audio Context 相關變數
let audioContext = null;
let mediaStreamSource = null;
let audioWorkletNode = null;

let isIntentionalStop = false;
let retryCount = 0;
let lifecycleHandlers = { ...DEFAULT_LIFECYCLE_HANDLERS };
const MAX_RETRIES = 10;

// Trace buffer (切句問題追蹤用)
let traceBuffer = [];
let traceStartTime = 0;

// #endregion

// #region [設定與配置]
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_MODEL = "stt-rt-preview";
const AUTO_STOP_TIMEOUT = 5 * 60 * 1000;
const ENDPOINT_TOKEN = "<end>";
const FINISHED_TOKEN = "<fin>";

// 客戶端斷句參數
//   MAX_BUFFER_LENGTH：累積文字超過此長度強制斷句 (極端情境防呆，正常切句完全交給 Soniox endpoint)
const MAX_BUFFER_LENGTH = 250;
const TRACE_BUFFER_LIMIT = 100;

// AudioWorklet 處理器代碼 (Deepgram 版と同じ)
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const bs = options?.processorOptions?.bufferSize;
    this.bufferSize = Number.isFinite(bs) ? bs : 2048;
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
      const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
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

async function fetchSonioxTemporaryToken() {
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
    const tokenUrl = new URL("/soniox/token", serviceBaseUrl).toString();
    const response = await fetch(tokenUrl, {
      headers: serviceApiKey ? { "x-api-key": serviceApiKey } : {}
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} - ${await response.text()}`);

    const data = await response.json();
    const tempKey = [data.key, data.api_key, data.access_token].find(
      (value) => typeof value === "string" && value.trim()
    );
    if (!tempKey) return null;

    return { value: tempKey.trim() };
  } catch (error) {
    if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "取得臨時 Token 失敗", error);
    return null;
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

function recordTrace(type, payload = {}) {
  if (traceStartTime === 0) traceStartTime = Date.now();
  traceBuffer.push({
    t: Date.now() - traceStartTime,
    type,
    ...payload
  });
  if (traceBuffer.length > TRACE_BUFFER_LIMIT) {
    traceBuffer.shift();
  }
}

function exposeTraceTools() {
  if (typeof window === "undefined") return;
  if (window.__sonioxDownloadTrace) return;

  window.__sonioxTrace = () => {
    console.table(traceBuffer);
    return traceBuffer;
  };

  window.__sonioxDownloadTrace = () => {
    if (traceBuffer.length === 0) {
      console.warn("[SonioxTrace] 沒有資料可下載");
      return;
    }
    const blob = new Blob([JSON.stringify(traceBuffer, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `soniox-trace-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.info(`[SonioxTrace] 已下載 ${traceBuffer.length} 筆事件`);
  };

  window.__sonioxClearTrace = () => {
    traceBuffer = [];
    traceStartTime = 0;
    console.info("[SonioxTrace] 已清空");
  };
}
// #endregion

// #region [核心服務控制]

function resetTranscriptBuffers() {
  finalizedText = "";
  nonFinalizedText = "";
}

function flushSentenceBuffer(onTranscriptUpdate, reason) {
  const finalSnapshot = finalizedText;
  const nonFinalSnapshot = nonFinalizedText;
  const merged = removeJapaneseSpaces((finalizedText + nonFinalizedText).trim());

  if (merged.length === 0) {
    recordTrace('flush-skip', {
      reason,
      finalText: finalSnapshot,
      nonFinalText: nonFinalSnapshot
    });
    return false;
  }

  const punctuationOnly = merged === '？' || merged === '。' || merged === '、';

  if (isDebugEnabled()) console.info("[INFO]", "[SonioxService]", `${reason} 觸發斷句`);
  recordTrace('flush', {
    reason,
    merged,
    sent: punctuationOnly ? null : merged,
    finalText: finalSnapshot,
    nonFinalText: nonFinalSnapshot,
    punctuationOnly
  });

  if (onTranscriptUpdate && !punctuationOnly) {
    onTranscriptUpdate(merged, true, true);
  }

  resetTranscriptBuffers();
  return true;
}

function cleanupAudioResources(options = {}) {
  const keepStream = options.keepStream === true;

  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

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
    globalStream.getTracks().forEach(track => track.stop());
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
 * 啟動 Soniox 語音辨識服務
 */
export async function startSoniox(langId, onTranscriptUpdate, handlers = {}) {
  setLifecycleHandlers(handlers);
  globalOnTranscriptUpdate = onTranscriptUpdate;
  if (isRunning) return true;

  exposeTraceTools();
  recordTrace('start', { langId });

  notifyStatusChange('接続中。しばらくお待ちください...');
  const langObj = getLang(langId);
  if (!langObj) {
    if (isDebugEnabled()) console.error("[ERROR] [Soniox] 找不到語系定義:", langId);
    return false;
  }

  lastSpeechTime = Date.now();

  const authInfo = await fetchSonioxTemporaryToken();
  if (!authInfo?.value) {
    notifyStatusChange("Soniox 臨時 Token 取得失敗、Web Speech API へ切り替えます...");
    return false;
  }

  isIntentionalStop = false;
  if (!retryCount) retryCount = 0;

  try {
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

    try {
      audioContext = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
      if (isDebugEnabled()) console.warn("[WARN]", "不支援指定採樣率，使用系統預設值", e);
      audioContext = new AudioContext();
    }
    const finalSampleRate = audioContext.sampleRate;
    if (isDebugEnabled()) console.info("[INFO]", "[AudioContext] 最終運作 SampleRate:", finalSampleRate);

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
    let isConfigured = false;

    audioWorkletNode.port.onmessage = (event) => {
      // 設定 JSON が server に届くまでは音声を送らず、ためておく。
      if (socket?.readyState === 1 && isConfigured) {
        socket.send(event.data);
      } else {
        pendingAudioChunks.push(event.data);
      }
    };

    socket = new WebSocket(SONIOX_WS_URL);

    socket.onopen = () => {
      // Soniox は接続直後に JSON で初期設定を送る必要がある。
      const config = {
        api_key: authInfo.value,
        model: SONIOX_MODEL,
        audio_format: "pcm_s16le",
        sample_rate: finalSampleRate,
        num_channels: 1,
        language_hints: [langObj.deepgramCode],
        enable_endpoint_detection: true
      };

      try {
        socket.send(JSON.stringify(config));
        isConfigured = true;
        isRunning = true;
        notifyStatusChange("Soniox 接続成功 (Raw Audio Mode)");

        if (pendingAudioChunks.length > 0) {
          if (isDebugEnabled()) console.info("[INFO]", "[SonioxService]", `送出 ${pendingAudioChunks.length} 個暫存音訊片段`);
          for (const chunk of pendingAudioChunks) {
            socket.send(chunk);
          }
          pendingAudioChunks.length = 0;
        }

        watchdogInterval = setInterval(() => {
          if (Date.now() - lastSpeechTime > AUTO_STOP_TIMEOUT) {
            notifyStatusChange("⚠️ 長時間無音のため、自動的に切斷しました (成本節約)。");
            stopSoniox({ intentional: false, reason: 'auto-timeout' });
          }
        }, 10000);
      } catch (err) {
        if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "送出設定失敗", err);
        notifyStatusChange("Soniox 設定送信失敗。");
      }
    };

    socket.onmessage = (message) => {
      try {
        const received = JSON.parse(message.data);

        // エラー応答の検出
        if (received.error_code || received.error_message) {
          if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "Soniox 錯誤", received);
          notifyStatusChange(`Soniox エラー: ${received.error_message || received.error_code}`);
          return;
        }

        const tokens = Array.isArray(received.tokens) ? received.tokens : [];
        if (tokens.length === 0) return;

        const finalBefore = finalizedText;
        const nonFinalBefore = nonFinalizedText;

        let endpointDetected = false;
        let newNonFinalText = "";
        let addedFinalThisRound = "";

        for (const token of tokens) {
          const tokenText = typeof token.text === "string" ? token.text : "";
          if (!tokenText) continue;

          // 特殊トークン処理
          if (tokenText === ENDPOINT_TOKEN) {
            endpointDetected = true;
            continue;
          }
          if (tokenText === FINISHED_TOKEN) {
            // ストリーム終了マーカー、無視
            continue;
          }

          if (token.is_final) {
            finalizedText += tokenText;
            addedFinalThisRound += tokenText;
          } else {
            newNonFinalText += tokenText;
          }
        }

        // non-final 部分は毎メッセージ置き換え (Soniox の仕様)
        nonFinalizedText = newNonFinalText;

        recordTrace('message', {
          tokens: tokens.map(tok => ({ text: tok.text, final: !!tok.is_final })),
          finalBefore,
          nonFinalBefore,
          finalAfter: finalizedText,
          nonFinalAfter: nonFinalizedText,
          addedFinal: addedFinalThisRound,
          endpoint: endpointDetected
        });

        const hasActivity = addedFinalThisRound.length > 0 || newNonFinalText.length > 0;
        if (hasActivity) lastSpeechTime = Date.now();

        // 切句完全交給 Soniox endpoint
        if (endpointDetected) {
          flushSentenceBuffer(onTranscriptUpdate, "⚡ endpoint");
          return;
        }

        // 長度防呆：累積過長強制斷句 (Soniox 不送 endpoint 的極端情境)
        if ((finalizedText + nonFinalizedText).length >= MAX_BUFFER_LENGTH) {
          flushSentenceBuffer(onTranscriptUpdate, "⚡ 最大長度強制斷");
          return;
        }

        // 通常の interim 表示
        const display = removeJapaneseSpaces((finalizedText + nonFinalizedText).trim());
        if (display.length > 0 && onTranscriptUpdate) {
          onTranscriptUpdate(display, false, false);
        }
      } catch (e) {
        if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "解析訊息失敗", e);
      }
    };

    socket.onclose = (event) => {
      if (isIntentionalStop) {
        notifyStatusChange('');
      } else {
        if (isDebugEnabled()) console.warn("[WARN] Soniox 意外斷線，準備重連...");

        if (retryCount < MAX_RETRIES) {
          const delay = 800;
          retryCount++;
          notifyStatusChange(`接続が切断されました。再接続中...`);
          cleanupAudioResources({ keepStream: true });
          isRunning = false;
          setTimeout(() => {
            startSoniox(langId, onTranscriptUpdate, lifecycleHandlers);
          }, delay);
        } else {
          notifyStatusChange("再接続に失敗しました。手動で再開してください。");
          stopSoniox({ intentional: false, reason: 'retry-exhausted' });
        }
      }
    };

    socket.onerror = (e) => {
      if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "Socket 錯誤", e);
      notifyStatusChange("Soniox 接続エラー。バックエンドまたはネットワークを確認してください。");
    };
  } catch (error) {
    if (isDebugEnabled()) console.error("[ERROR]", "[SonioxService]", "啟動失敗", error);
    stopSoniox({ intentional: false, reason: 'startup-error' });
    return false;
  }
  return true;
}

export function stopSoniox(options = {}) {
  const intentional = options.intentional !== false;
  const reason = options.reason || (intentional ? 'manual-stop' : 'service-stop');

  recordTrace('stop', { reason, intentional });

  const hadSession =
    isRunning ||
    !!socket ||
    !!globalStream ||
    !!audioContext ||
    !!mediaStreamSource ||
    !!audioWorkletNode;

  // 停止前に残留テキストを flush
  const remainingText = removeJapaneseSpaces((finalizedText + nonFinalizedText).trim());
  if (remainingText.length > 0 && globalOnTranscriptUpdate) {
    globalOnTranscriptUpdate(remainingText, true, true);
  }

  isRunning = false;
  isIntentionalStop = intentional;
  retryCount = 0;
  resetTranscriptBuffers();
  lastSpeechTime = 0;
  globalOnTranscriptUpdate = null;

  cleanupAudioResources();

  if (isDebugEnabled()) console.info("[INFO]", "[SonioxService]", "Soniox 服務已停止");

  if (intentional) {
    notifyStatusChange('');
  }

  if (hadSession) {
    notifyStopped(reason, intentional);
  }
}
// #endregion
