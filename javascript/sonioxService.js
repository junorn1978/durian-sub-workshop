/**
 * @file sonioxService.js
 * @description 管理 Soniox WebSocket 連線與音訊串流。
 *
 * 實作要點：
 * - 驗證是在連線後的第一則 JSON 訊息中傳送 api_key（並非 sub-protocol）。
 * - 結果以 token 為單位傳回。is_final=true 表示已確認，false 表示暫定（可能被下一則訊息取代）。
 * - 端點偵測會以 <end> token 的形式傳送。一則訊息可能夾帶多個 <end>，需逐一就地斷句。
 */

import { getLang, getSonioxEndpointSettings } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger('Soniox');

const DEFAULT_LIFECYCLE_HANDLERS = {
  onStatusChange: () => {},
  onStop: () => {}
};

// #region [全域狀態變數]
let socket = null;
let isRunning = false;
let watchdogInterval = null;
let reconnectTimer = null;
let lastSpeechTime = 0;

// Soniox token-based 累積緩衝區
let finalizedText = "";        // is_final=true 的 token 串接（僅附加）
let nonFinalizedText = "";     // 每則訊息都會被取代的 interim 部分

// 軟性斷句已經送去翻譯、但仍要留在字幕上的部分。
// 翻譯需要切成小段（避免整段講完才送出），但字幕不需要——切開反而讓觀眾
// 看到話講到一半就被抽掉。因此顯示走累積，翻譯走分段，直到 endpoint 才一起歸零。
let displayCarryText = "";

// 診斷用。評估能不能改用「token 之間的靜音間隔」取代字數來斷句。
// 只統計已確認的 token：暫定 token 每則訊息都會重送，會重複計算。
let lastFinalEndMs = null;     // 上一個已確認 token 的結束時刻
let finalGaps = [];            // { atChar, gapMs }，atChar 是 finalizedText 內的位置

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

// #endregion

// #region [設定與配置]
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_MODEL = "stt-rt-v5";
// 因無聲而自動中斷連線的門檻。
// 計算的不是「麥克風無聲」的時間，而是「Soniox 未傳回任何文字」的時間。背景音樂或鍵盤聲
// 不會使其更新，因此閱讀留言、專心玩遊戲等長時間不說話的情況也會持續計時。
// 預期使用暫停（點擊標誌）來處理刻意休息的情況，此處則作為忘記離席時的保險，設定得較長。
const AUTO_STOP_TIMEOUT = 30 * 60 * 1000;
const ENDPOINT_TOKEN = "<end>";
const FINISHED_TOKEN = "<fin>";

// 客戶端斷句參數
//   SOFT_SPLIT_LENGTH：累積文字超過此長度時，在最後一個句末標點處切開送去翻譯（字幕不切）
//   MAX_BUFFER_LENGTH：累積文字超過此長度強制斷句 (極端情境防呆，找不到標點時的最後手段)
const SOFT_SPLIT_LENGTH = 80;
const MAX_BUFFER_LENGTH = 250;
const SENTENCE_END_PATTERN = /[。！？!?]/g;

// AudioWorklet 處理器代碼
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
    log.error("取得臨時 Token 失敗", error);
    return null;
  }
}

// Soniox context（辨識詞調整）。不依賴語系，整個 session 僅傳送一次。
//   - terms：提高專有名詞、術語辨識準確度的字串陣列
//   - general：傳達直播領域背景的 {key, value} 陣列
// 規格上限約為 10,000 個字元（terms + general + text 合計）。
let sonioxContextCache = null;     // 若已載入則不再 fetch
let sonioxContextLoaded = false;

async function loadSonioxContext() {
  if (sonioxContextLoaded) return sonioxContextCache;
  sonioxContextLoaded = true;
  try {
    const response = await fetch("data/soniox_context.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const terms = Array.isArray(data.terms)
      ? data.terms.filter((t) => typeof t === "string" && t.trim())
      : [];
    const general = Array.isArray(data.general)
      ? data.general.filter(
          (g) => g && typeof g.key === "string" && typeof g.value === "string" && g.value.trim()
        )
      : [];

    const context = {};
    if (terms.length) context.terms = terms;
    if (general.length) context.general = general;

    sonioxContextCache = Object.keys(context).length ? context : null;
  } catch (error) {
    log.warn("辨識詞 context 載入失敗，將不送 context", error);
    sonioxContextCache = null;
  }
  return sonioxContextCache;
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

function resetTranscriptBuffers() {
  finalizedText = "";
  nonFinalizedText = "";
  displayCarryText = "";
  lastFinalEndMs = null;
  finalGaps = [];
}

/** 目前應該顯示在字幕上的完整文字（含軟性斷句已送出的部分）。 */
function buildDisplayText() {
  return removeJapaneseSpaces((displayCarryText + finalizedText + nonFinalizedText).trim());
}

/** 診斷用。把這一段裡的靜音間隔整理成一行紀錄。 */
function logSegmentGaps(reason, length, gaps) {
  const maxGap = gaps.reduce((max, g) => Math.max(max, g.gapMs), 0);
  log.debug("斷句診斷", {
    原因: reason,
    字數: length,
    最大間隔: maxGap,
    間隔數: gaps.length,
    明細: gaps.map(g => `${g.atChar}字/${g.gapMs}ms`).join(' ') || '（無時間戳或全程無停頓）'
  });
}

function flushSentenceBuffer(onTranscriptUpdate, reason) {
  // merged 是「還沒送去翻譯」的部分，display 是「畫面上該有的全文」。
  const merged = removeJapaneseSpaces((finalizedText + nonFinalizedText).trim());
  const display = buildDisplayText();

  if (merged.length === 0) return false;

  const punctuationOnly = merged === '？' || merged === '。' || merged === '、';

  logSegmentGaps(reason, merged.length, finalGaps);

  if (onTranscriptUpdate && !punctuationOnly) {
    onTranscriptUpdate(display, true, true, merged);
  }

  resetTranscriptBuffers();
  return true;
}

/**
 * 長串發話用的軟性斷句。切的是「送去翻譯的單位」，不是字幕。
 *
 * 連續說話的人幾乎不停頓，Soniox 因此長時間不送 <end>。整段講完才送翻譯的話，
 * 外語觀眾會落後數十秒。超過門檻就在最後一個句末標點處切開，先把前半段送出去
 * 翻譯，其餘留在緩衝區繼續累積。
 *
 * 字幕不跟著切——顯示端走 displayCarryText 累積全文，否則觀眾會看到話講到一半
 * 被抽掉。原文有單行顯示，長句本來就不太受影響。
 *
 * 因為只在標點切，不會像 MAX_BUFFER_LENGTH 那樣把詞剖成兩半。門檻以下完全不
 * 動作，所以講話會停頓的人不受影響。
 *
 * 只切已確認（is_final）的部分。暫定文字之後可能被改寫，先送出去會造成重複。
 */
function flushBySoftSplit(onTranscriptUpdate) {
  if (finalizedText.length < SOFT_SPLIT_LENGTH) return false;

  // 取最後一個標點，讓切出來的一段盡量完整。這個檢查每則訊息都會跑，
  // finalizedText 是逐步成長的，因此實際切點大多落在門檻附近。
  SENTENCE_END_PATTERN.lastIndex = 0;
  let cutIndex = -1;
  let match;
  while ((match = SENTENCE_END_PATTERN.exec(finalizedText)) !== null) {
    cutIndex = match.index;
  }
  if (cutIndex < 0) return false;

  const merged = removeJapaneseSpaces(finalizedText.slice(0, cutIndex + 1).trim());
  if (merged.length === 0) return false;

  // 切點之前的間隔屬於送出的這一段，之後的要跟著殘留一起平移。
  const cutAt = cutIndex + 1;
  logSegmentGaps("軟性斷句", merged.length, finalGaps.filter(g => g.atChar < cutAt));
  finalGaps = finalGaps
    .filter(g => g.atChar >= cutAt)
    .map(g => ({ atChar: g.atChar - cutAt, gapMs: g.gapMs }));

  finalizedText = finalizedText.slice(cutIndex + 1);

  // 切出來的一段送去翻譯，但畫面保留累積的全文。
  displayCarryText += merged;
  log.debug("軟性斷句", { 送出翻譯: merged, 殘留: finalizedText.length });
  if (onTranscriptUpdate) onTranscriptUpdate(buildDisplayText(), true, true, merged);
  return true;
}

function emitInterim(onTranscriptUpdate) {
  const display = buildDisplayText();
  if (display.length > 0 && onTranscriptUpdate) {
    onTranscriptUpdate(display, false, false);
  }
}

/**
 * 取消已排程的重新連線。防止停止或暫停後立即執行重新連線，
 * 導致 UI 顯示已停止，但只有連線恢復（＝持續計費）。
 */
function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
    audioContext.close().catch(err => { log.error("AudioContext 關閉失敗", err); });
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

  notifyStatusChange('接続しています。しばらくお待ちください...');
  const langObj = getLang(langId);
  if (!langObj) {
    log.error("找不到語系定義:", langId);
    return false;
  }

  lastSpeechTime = Date.now();

  const authInfo = await fetchSonioxTemporaryToken();
  if (!authInfo?.value) {
    notifyStatusChange("Soniox の一時トークンを取得できませんでした。Web Speech API に切り替えます...");
    return false;
  }

  const sonioxContext = await loadSonioxContext();

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

    try {
      audioContext = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
      log.warn("不支援指定採樣率，使用系統預設值", e);
      audioContext = new AudioContext();
    }
    const finalSampleRate = audioContext.sampleRate;

    const TARGET_CHUNK_SEC = 0.1;
    let targetBufferSize = Math.round(finalSampleRate * TARGET_CHUNK_SEC);
    targetBufferSize = Math.max(256, Math.round(targetBufferSize / 256) * 256);

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
      // 設定 JSON 傳到 server 前先不傳送音訊，而是暫存起來。
      if (socket?.readyState === 1 && isConfigured) {
        socket.send(event.data);
      } else {
        pendingAudioChunks.push(event.data);
      }
    };

    socket = new WebSocket(SONIOX_WS_URL);

    socket.onopen = () => {
      // 從設定 UI 取得端點偵測的調整值（連線時確定）。
      const endpoint = getSonioxEndpointSettings();

      // Soniox 必須在連線後立即透過 JSON 傳送初始設定。
      const config = {
        api_key: authInfo.value,
        model: SONIOX_MODEL,
        audio_format: "pcm_s16le",
        sample_rate: finalSampleRate,
        num_channels: 1,
        language_hints: langObj.deepgramCode === "en" ? ["en", "ja"] : [langObj.deepgramCode, "en"],
        language_hints_strict: true,
        enable_endpoint_detection: true,
        endpoint_latency_adjustment_level: endpoint.latencyLevel,
        endpoint_sensitivity: endpoint.sensitivity,
        max_endpoint_delay_ms: endpoint.maxDelayMs
      };

      // 實際送出的端點偵測值。這三項來自 localStorage，未必等於 config.js 的預設，
      // 因此把真正生效的數字留在紀錄裡，調參數時才不必猜。
      log.info("Soniox 設定", {
        latencyLevel: endpoint.latencyLevel,
        sensitivity: endpoint.sensitivity,
        maxDelayMs: endpoint.maxDelayMs,
        softSplit: SOFT_SPLIT_LENGTH
      });

      // 辨識詞調整（context）不依賴語系。若為空則不傳送。
      if (sonioxContext) {
        config.context = sonioxContext;
      }

      try {
        socket.send(JSON.stringify(config));
        isConfigured = true;
        isRunning = true;
        notifyStatusChange("Soniox に接続しました。");

        if (pendingAudioChunks.length > 0) {
          for (const chunk of pendingAudioChunks) {
            socket.send(chunk);
          }
          pendingAudioChunks.length = 0;
        }

        watchdogInterval = setInterval(() => {
          if (Date.now() - lastSpeechTime > AUTO_STOP_TIMEOUT) {
            log.warn(`${AUTO_STOP_TIMEOUT / 60000}分間認識結果がなかったため自動切断`);
            notifyStatusChange(`${AUTO_STOP_TIMEOUT / 60000}分以上音声が検出されなかったため、自動的に切断しました。`);
            stopSoniox({ intentional: false, reason: 'auto-timeout' });
          }
        }, 10000);
      } catch (err) {
        log.error("送出設定失敗", err);
        notifyStatusChange("Soniox の設定送信に失敗しました。");
      }
    };

    socket.onmessage = (message) => {
      try {
        const received = JSON.parse(message.data);

        // 偵測錯誤回應
        if (received.error_code || received.error_message) {
          log.error("Soniox 錯誤", received);
          notifyStatusChange(`Soniox エラー: ${received.error_message || received.error_code}`);
          return;
        }

        const tokens = Array.isArray(received.tokens) ? received.tokens : [];
        if (tokens.length === 0) return;

        let flushedByEndpoint = false;
        let newNonFinalText = "";
        let addedFinalThisRound = "";

        for (const token of tokens) {
          const tokenText = typeof token.text === "string" ? token.text : "";
          if (!tokenText) continue;

          // 處理特殊 token
          // 一則訊息可能夾帶多個 <end>（兩人同時說話、搭腔時很常見）。
          // 若只設旗標、等迴圈跑完才結算一次，後一句會被併進前一句，
          // 兩位講者的話因此擠成同一行字幕，也會被當成同一句送去翻譯；
          // 改成遇到就地結算。
          if (tokenText === ENDPOINT_TOKEN) {
            nonFinalizedText = newNonFinalText;
            newNonFinalText = "";
            flushSentenceBuffer(onTranscriptUpdate, "⚡ endpoint");
            flushedByEndpoint = true;
            continue;
          }
          if (tokenText === FINISHED_TOKEN) {
            // 串流結束標記，忽略
            continue;
          }

          if (token.is_final) {
            // 診斷用。與上一個已確認 token 之間的靜音長度，200ms 以下當成連續發話。
            if (typeof token.start_ms === "number" && lastFinalEndMs !== null) {
              const gapMs = token.start_ms - lastFinalEndMs;
              if (gapMs >= 200) finalGaps.push({ atChar: finalizedText.length, gapMs });
            }
            if (typeof token.end_ms === "number") lastFinalEndMs = token.end_ms;

            finalizedText += tokenText;
            addedFinalThisRound += tokenText;
          } else {
            newNonFinalText += tokenText;
          }
        }

        // 每則訊息都會取代 non-final 部分（Soniox 規格）。
        // 若上面已就地結算過，這裡放的是最後一個 <end> 之後的殘留。
        nonFinalizedText = newNonFinalText;

        const hasActivity = addedFinalThisRound.length > 0 || newNonFinalText.length > 0;
        if (hasActivity) lastSpeechTime = Date.now();

        // 切句完全交給 Soniox endpoint
        if (flushedByEndpoint) {
          // <end> 之後還有殘留的 interim（下一句已經開始講）就先顯示出來
          if (nonFinalizedText) emitInterim(onTranscriptUpdate);
          return;
        }

        // 長串發話的軟性斷句。細節見 flushBySoftSplit。
        flushBySoftSplit(onTranscriptUpdate);

        // 長度防呆：累積過長強制斷句 (Soniox 不送 endpoint 且找不到標點的極端情境)
        if ((finalizedText + nonFinalizedText).length >= MAX_BUFFER_LENGTH) {
          flushSentenceBuffer(onTranscriptUpdate, "⚡ 最大長度強制斷");
          return;
        }

        // 一般的 interim 顯示
        emitInterim(onTranscriptUpdate);
      } catch (e) {
        log.error("解析訊息失敗", e);
      }
    };

    socket.onclose = (event) => {
      if (isIntentionalStop) {
        notifyStatusChange('');
      } else {
        log.warn("Soniox 意外斷線，準備重連...");

        if (retryCount < MAX_RETRIES) {
          const delay = 800;
          retryCount++;
          notifyStatusChange(`接続が切断されました。再接続しています...`);
          cleanupAudioResources({ keepStream: true });
          isRunning = false;
          clearReconnectTimer();
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            // 若在等待期間停止或暫停，則不恢復連線。
            if (isIntentionalStop) return;
            startSoniox(langId, onTranscriptUpdate, lifecycleHandlers);
          }, delay);
        } else {
          notifyStatusChange("再接続に失敗しました。もう一度「開始」を押してください。");
          stopSoniox({ intentional: false, reason: 'retry-exhausted' });
        }
      }
    };

    socket.onerror = (e) => {
      log.error("Socket 錯誤", e);
      notifyStatusChange("Soniox の接続エラーです。バックエンドまたはネットワークを確認してください。");
    };
  } catch (error) {
    log.error("啟動失敗", error);
    stopSoniox({ intentional: false, reason: 'startup-error' });
    return false;
  }
  return true;
}

export function stopSoniox(options = {}) {
  const intentional = options.intentional !== false;
  const reason = options.reason || (intentional ? 'manual-stop' : 'service-stop');

  const hadSession =
    isRunning ||
    !!socket ||
    !!globalStream ||
    !!audioContext ||
    !!mediaStreamSource ||
    !!audioWorkletNode;

  // 停止前 flush 殘留文字
  const remainingText = removeJapaneseSpaces((finalizedText + nonFinalizedText).trim());
  if (remainingText.length > 0 && globalOnTranscriptUpdate) {
    globalOnTranscriptUpdate(remainingText, true, true);
  }

  isRunning = false;
  isIntentionalStop = intentional;
  retryCount = 0;
  clearReconnectTimer();
  resetTranscriptBuffers();
  lastSpeechTime = 0;
  globalOnTranscriptUpdate = null;

  cleanupAudioResources();

  log.info("Soniox 服務已停止");

  if (intentional) {
    notifyStatusChange('');
  }

  if (hadSession) {
    notifyStopped(reason, intentional);
  }
}
// #endregion
