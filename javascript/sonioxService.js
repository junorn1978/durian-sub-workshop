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
import { getSelectedMicId } from "./micSelector.js";

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

// 斷句診斷。用來評估能不能改用「token 之間的靜音間隔」取代字數來斷句。
// 只記已確認的 token：暫定 token 每則訊息都會重送，會重複計算。
//
// 存原始時間戳而不是預先算好的間隔，是因為間隔、發聲長度、語速、段落時長全都能從
// 這一份推導出來，反過來不行。軟性斷句要把資料拆成兩半時，也只要用 atChar 篩選，
// 不必分別維護好幾個累計值。
let finalTokens = [];          // { atChar, startMs, endMs }，atChar 是 finalizedText 內的位置

// 這一段的已確認文字是分幾則 WebSocket 訊息湊齊的。
//
// 用來判斷「按字數軟斷」這條路走不走得通。實測 25 段裡軟斷只觸發 1 次，連累積到
// 65 字（門檻是 60）的段落都仍由 endpoint 切走，懷疑 Soniox 的 is_final 是成批在
// endpoint 附近才確認的——若真是如此，finalizedText 不會慢慢長到門檻，而是一口氣
// 跳過去，且那則訊息帶著 <end> 會提前 return，根本走不到 flushBySoftSplit。
// 長段落若回報 1～2 則，推測即成立。
let finalMsgCount = 0;

let globalStream = null;
let globalOnTranscriptUpdate = null;

// Audio Context 相關變數
// 音訊路徑在開始時建一次，直到停止才拆。斷線重連只重接 socket，
// 這段期間的音訊先存在 pendingAudioChunks，接上後補送，不會掉話。
let audioContext = null;
let mediaStreamSource = null;
let highpassNode = null;
let audioWorkletNode = null;
let sinkGainNode = null;

let isConfigured = false;          // config JSON 已送出，可以送音訊
let pendingAudioChunks = [];

// 每次開始 / 停止都 +1。舊連線、舊計時器、舊音訊回呼都靠這個判斷自己已經過期，
// 不必一個個去拔 handler。
let session = 0;
let sessionLangObj = null;

let retryCount = 0;
let lifecycleHandlers = { ...DEFAULT_LIFECYCLE_HANDLERS };
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 800;
// 斷線期間最多存多少音訊。一塊約 0.1 秒，200 塊約 20 秒；再多就算接回來也太晚了。
const PENDING_CHUNK_LIMIT = 200;

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
//   CONTEXT_MAX_LENGTH：當作前文送出的字數上限
//
// 60 是實測算出來的。字幕欄只有一行，OBS 視窗約 1280px 時一行放得下 109 個英文
// 字元；英譯長度約為日文原文的 1.81 倍，所以原文超過 60 字，英譯就得靠後端的
// 單字數上限壓縮才塞得進去——那正是譯文掉句尾、掉語氣的原因。
// 再往下降沒有意義：實測 55 和 50 的結果與 60 完全相同，因為卡住的是「這段話裡
// 有沒有標點可切」，不是門檻。
const SOFT_SPLIT_LENGTH = 60;
const MAX_BUFFER_LENGTH = 250;
const CONTEXT_MAX_LENGTH = 100;
const SENTENCE_END_PATTERN = /[。！？!?]/g;

// 診斷資料最多附上幾組間隔。MAX_BUFFER_LENGTH 是 250 字，極端情況可能累積上百個
// token，全部附上會讓每一行紀錄長到難以閱讀。被截掉的數量仍可由 toks 推算，
// 因此這個上限只影響明細，不影響統計。
const DIAG_GAP_LIMIT = 100;

// AudioWorklet 處理器（Float32 → pcm_s16le，每約 100ms 送一塊）
const WORKLET_PROCESSOR_NAME = 'soniox-pcm-processor';
const WORKLET_MODULE_URL = new URL('./sonioxPcmWorklet.js', import.meta.url).href;
const PCM_TARGET_CHUNK_MS = 100;
// Chrome 153+ 起 AudioContext 可指定 render quantum（預設 128 frames）。拉到 512 之後
// worklet 的 process() 由每秒 125 次降到 31 次，送出的 chunk 大小不變，純粹省 callback。
// 舊版會忽略不認得的成員。（沿用 hamham即時翻譯 的做法）
const RENDER_SIZE_HINT = 512;
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
  finalTokens = [];
  finalMsgCount = 0;
}

/** 目前應該顯示在字幕上的完整文字（含軟性斷句已送出的部分）。 */
function buildDisplayText() {
  return removeJapaneseSpaces((displayCarryText + finalizedText + nonFinalizedText).trim());
}

/**
 * 送去翻譯時附帶的前文。只在軟性斷句發生過時才有值。
 *
 * displayCarryText 裝的是「同一句話裡已經送出去的前半部」，中間沒有 <end>，
 * 因此必定是同一個人、同一句話、時間上緊鄰——正是我們自己硬切開的地方，
 * 補上前文是修補，不是猜測。
 *
 * 反過來說跨 endpoint 就不帶。endpoint 是 Soniox 判定的真實句子邊界，前一句
 * 很可能是別人的留言（主播會念留言）或旁邊的人講的話，拿來當前文會餵錯資訊。
 * displayCarryText 在 endpoint 時歸零，所以這個規則自動成立，不需要旗標。
 */
function buildContextText() {
  const context = removeJapaneseSpaces(displayCarryText.trim());
  if (!context) return null;
  return context.length > CONTEXT_MAX_LENGTH ? context.slice(-CONTEXT_MAX_LENGTH) : context;
}

/**
 * 把一段話的時序整理成診斷資料，跟著翻譯請求一起送到後端。
 *
 * 只放數字與分類，不放任何文字。後端的 [翻譯完成] 那一行已經有原文了，用
 * sequenceId 就能對上；重複帶一份只會讓紀錄多留一份內容，而前端的 ray mode
 * 遮蔽也管不到後端的紀錄。
 *
 * 一律送原始值、不送算好的比率——語速（chars ÷ voiceMs）和靜音佔比
 * （1 − voiceMs ÷ durMs）事後都推導得出來。現在還不知道哪個指標才是對的，
 * 先把公式寫死在前端的話，換算方式一改就得重新收一次資料。
 *
 * @param {'soft'|'endpoint'|'maxlen'|'reconnect'|'stop'} cut - 這一段是被什麼切出來的
 * @param {number} chars - 送去翻譯的字數
 * @param {number} ctxChars - 附帶前文的字數
 * @param {Array<{atChar:number,startMs:number,endMs:number}>} tokens - 這一段的 token 時間戳
 * @param {number} msgs - 這一段的已確認文字分幾則訊息湊齊。軟性斷句時涵蓋的是整段
 *   發話至今，不只送出去的那一半——殘留會繼續累積，無法依 atChar 切分。
 */
function buildSegmentDiag(cut, chars, ctxChars, tokens, msgs) {
  const diag = { cut, chars, ctx: ctxChars, toks: tokens.length, msgs };
  if (tokens.length === 0) return diag;

  // 只記非零間隔。連續發話時 start_ms 會緊貼前一個 end_ms，間隔為 0 的佔大多數，
  // 逐一列出只是雜訊；要算分位數時用 toks 減掉 gaps.length 就知道有幾個零。
  const gaps = [];
  let voiceMs = 0;
  for (let i = 0; i < tokens.length; i++) {
    voiceMs += tokens[i].endMs - tokens[i].startMs;
    if (i === 0) continue;
    const gapMs = tokens[i].startMs - tokens[i - 1].endMs;
    if (gapMs > 0 && gaps.length < DIAG_GAP_LIMIT) gaps.push([tokens[i].atChar, gapMs]);
  }

  diag.t0 = tokens[0].startMs;                                      // 音訊時間軸上的起點
  diag.durMs = tokens[tokens.length - 1].endMs - tokens[0].startMs; // 這一段橫跨多久

  // ⚠ 這不是「發聲時間」。實測 25 段全部滿足 voiceMs ≈ toks × 60ms——Soniox 給每個
  //   token 的時長是固定的 60ms 量化值，與那個字實際唸多久無關（所有 gap 也都是 60
  //   的倍數）。因此語速要用 chars ÷ durMs 算，用 voiceMs 算出來的是「每個 token 幾
  //   個字」，會得到 40 字/秒 這種人類做不到的數字。
  //   保留這個欄位只為了哪天 Soniox 換了量化單位時看得出來。
  diag.voiceMs = voiceMs;

  // ⚠ 同理，gap 不等於靜音。token 時長被壓成 60ms，那個字實際還在唸的時間會被算進
  //   後面的 gap 裡（唱歌段落的拉長尾音就是這樣變成 1 秒以上的「間隔」）。
  //   比相對大小（分位數）仍然有效，但不能拿絕對毫秒數去對照換氣時間。
  diag.gaps = gaps;                                                 // [atChar, gapMs]
  return diag;
}

/** 把診斷資料印成一行。送到後端的是同一份資料，這裡是給本機除錯看的。 */
function logSegmentDiag(reason, diag) {
  const gaps = diag.gaps || [];
  log.debug("斷句診斷", {
    原因: reason,
    字數: diag.chars,
    前文: diag.ctx,
    token數: diag.toks,
    訊息數: diag.msgs ?? '-',
    音訊長: diag.durMs ?? '-',
    發聲長: diag.voiceMs ?? '-',
    語速: diag.durMs > 0 ? `${(diag.chars / diag.durMs * 1000).toFixed(1)}字/秒` : '-',
    最大間隔: gaps.reduce((max, g) => Math.max(max, g[1]), 0),
    間隔數: gaps.length,
    明細: gaps.map(g => `${g[0]}字/${g[1]}ms`).join(' ') || '（無時間戳或全程無停頓）'
  });
}

/**
 * keepNonFinal：只送出已確認的部分，暫定的留著。Soniox 之後會再送一次這些 token
 * （確認或修正後），一起送出的話，下一句開頭會重複上一句的後半段。
 * 只有長度上限這種「之後還會有後續」的切法才需要；endpoint 時暫定部分已經是空的。
 */
function flushSentenceBuffer(onTranscriptUpdate, reason, cut, { keepNonFinal = false } = {}) {
  // merged 是「還沒送去翻譯」的部分，display 是「畫面上該有的全文」。
  const pending = keepNonFinal ? nonFinalizedText : "";
  const merged = removeJapaneseSpaces((keepNonFinal ? finalizedText : finalizedText + nonFinalizedText).trim());
  const display = keepNonFinal
    ? removeJapaneseSpaces((displayCarryText + finalizedText).trim())
    : buildDisplayText();

  if (merged.length === 0) return false;

  const punctuationOnly = merged === '？' || merged === '。' || merged === '、';

  const contextText = buildContextText();
  const diag = buildSegmentDiag(cut, merged.length, contextText?.length ?? 0, finalTokens, finalMsgCount);
  logSegmentDiag(reason, diag);

  if (onTranscriptUpdate && !punctuationOnly) {
    onTranscriptUpdate(display, true, true, { translateSource: merged, contextText, diag });
  }

  resetTranscriptBuffers();
  nonFinalizedText = pending;
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

  // 切點之前的 token 屬於送出的這一段，之後的要跟著殘留一起平移。
  const cutAt = cutIndex + 1;
  const sentTokens = finalTokens.filter(t => t.atChar < cutAt);
  finalTokens = finalTokens
    .filter(t => t.atChar >= cutAt)
    .map(t => ({ atChar: t.atChar - cutAt, startMs: t.startMs, endMs: t.endMs }));

  finalizedText = finalizedText.slice(cutIndex + 1);

  // 前文是「這一段之前已經送出去的部分」，所以要在併入 merged 之前取。
  const contextText = buildContextText();

  const diag = buildSegmentDiag('soft', merged.length, contextText?.length ?? 0, sentTokens, finalMsgCount);
  logSegmentDiag("軟性斷句", diag);

  // 切出來的一段送去翻譯，但畫面保留累積的全文。
  displayCarryText += merged;
  log.debug("軟性斷句", { 送出翻譯: merged, 殘留: finalizedText.length, 前文: contextText?.length ?? 0 });
  if (onTranscriptUpdate) {
    onTranscriptUpdate(buildDisplayText(), true, true, { translateSource: merged, contextText, diag });
  }
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

function closeSocketSilently() {
  isConfigured = false;
  if (!socket) return;
  const ws = socket;
  socket = null;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try { ws.close(); } catch { /* 已經關了 */ }
}

function stopWatchdog() {
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
}

function startWatchdog(sessionId) {
  stopWatchdog();
  watchdogInterval = setInterval(() => {
    if (sessionId !== session) return;
    if (Date.now() - lastSpeechTime > AUTO_STOP_TIMEOUT) {
      log.warn(`${AUTO_STOP_TIMEOUT / 60000}分間認識結果がなかったため自動切断`);
      notifyStatusChange(`${AUTO_STOP_TIMEOUT / 60000}分以上音声が検出されなかったため、自動的に切断しました。`);
      stopSoniox({ intentional: false, reason: 'auto-timeout' });
    }
  }, 10000);
}

function cleanupAudioResources() {
  stopWatchdog();
  closeSocketSilently();
  pendingAudioChunks = [];

  for (const node of [mediaStreamSource, highpassNode, audioWorkletNode, sinkGainNode]) {
    try { node?.disconnect(); } catch { /* 已經斷開 */ }
  }
  if (audioWorkletNode) audioWorkletNode.port.onmessage = null;
  mediaStreamSource = highpassNode = audioWorkletNode = sinkGainNode = null;

  if (audioContext) {
    audioContext.close().catch(err => { log.error("AudioContext 關閉失敗", err); });
    audioContext = null;
  }

  if (globalStream) {
    globalStream.getTracks().forEach(track => track.stop());
    globalStream = null;
  }
}

/**
 * 開左下角選定的麥克風；裝置不見了（拔掉、改名）就退回既定裝置。權限錯誤直接往上丟。
 * 前處理（AGC・回音消除・降噪）維持開啟：這是麥克風輸入，跟 hamham 的分頁音訊不同。
 */
const MIC_CONSTRAINTS = {
  autoGainControl:  true,
  echoCancellation: true,
  noiseSuppression: true,
  channelCount: 1,
};

async function openMicStream() {
  const deviceId = getSelectedMicId();
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } },
        video: false
      });
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
      log.warn("選択したマイクが見つからないため、既定のマイクを使います");
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
}

/* 麥克風被拔掉時：換到目前能開的裝置，連線不斷。 */
function watchMicEnded(stream, sessionId) {
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (sessionId !== session || stream !== globalStream) return;
    log.warn("マイクが切断されました。開き直します");
    switchSonioxMic();
  });
}

/**
 * 辨識中換麥克風（左下角選了別的、或裝置被拔掉）。只換音訊來源接到高通濾波器上，
 * AudioContext、worklet、Soniox 連線都不動，所以不會斷線也不會重新計費。
 * 一支麥克風都開不了才停止。
 */
export async function switchSonioxMic() {
  if (!isRunning || !audioContext || !highpassNode) return;
  const sessionId = session;

  let stream;
  try {
    stream = await openMicStream();
  } catch (err) {
    log.error("マイクを開き直せませんでした", err);
    if (sessionId !== session) return;
    notifyStatusChange("マイクが切断されました。接続を確認して、もう一度「開始」を押してください。");
    stopSoniox({ intentional: false, reason: 'mic-lost' });
    return;
  }
  if (sessionId !== session || !audioContext) {
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  const oldSource = mediaStreamSource;
  const oldStream = globalStream;
  mediaStreamSource = audioContext.createMediaStreamSource(stream);
  mediaStreamSource.connect(highpassNode);
  globalStream = stream;
  watchMicEnded(stream, sessionId);

  try { oldSource?.disconnect(); } catch { /* 已經斷開 */ }
  oldStream?.getTracks().forEach(t => t.stop());
  log.info("マイクを切り替えました:", stream.getAudioTracks()[0]?.label);
}

// renderSizeHint 是 Chrome 153+ 才有的成員，萬一實作對數值另有限制而丟例外，逐級退回原本的行為。
function createAudioContext() {
  const attempts = [
    { sampleRate: 16000, renderSizeHint: RENDER_SIZE_HINT },
    { sampleRate: 16000 },
    { renderSizeHint: RENDER_SIZE_HINT },
    {},
  ];
  let lastError = null;
  for (const options of attempts) {
    try {
      return new AudioContext(options);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * 麥克風 → 90Hz 高通 → PCM worklet。worklet 的輸出接到音量 0 的 GainNode 再進 destination，
 * 讓整條路徑一定會被拉動（沒有接到 destination 的節點，瀏覽器可以不處理）。
 *
 * 音訊塊送不出去時（連線中、斷線重連中）先存起來，config 送出後補送。
 */
async function buildAudioPipeline(stream, sessionId) {
  audioContext = createAudioContext();
  if (audioContext.state === 'suspended') await audioContext.resume();
  await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
  if (sessionId !== session) return;

  const sampleRate = audioContext.sampleRate;
  // renderQuantumSize 在 Chrome 153 之前是 undefined，當成預設的 128。
  const renderQuantum = Number(audioContext.renderQuantumSize) || 128;
  // buffer 對齊 render quantum 的整數倍；quantum 為 128 時就是原本的 256 對齊。
  const alignment = Math.max(256, renderQuantum);
  const bufferSize = Math.max(
    alignment,
    Math.round((sampleRate * PCM_TARGET_CHUNK_MS) / 1000 / alignment) * alignment,
  );

  mediaStreamSource = audioContext.createMediaStreamSource(stream);

  // 唯一的前處理：90Hz 高通，濾掉低頻隆隆聲與 DC offset。
  highpassNode = audioContext.createBiquadFilter();
  highpassNode.type = "highpass";
  highpassNode.frequency.value = 90;
  highpassNode.Q.value = 0.707;

  audioWorkletNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { bufferSize }
  });
  audioWorkletNode.port.onmessage = (event) => {
    if (sessionId !== session) return;
    if (socket?.readyState === WebSocket.OPEN && isConfigured) {
      socket.send(event.data);
    } else if (pendingAudioChunks.length < PENDING_CHUNK_LIMIT) {
      pendingAudioChunks.push(event.data);
    }
  };

  sinkGainNode = audioContext.createGain();
  sinkGainNode.gain.value = 0;

  mediaStreamSource.connect(highpassNode);
  highpassNode.connect(audioWorkletNode);
  audioWorkletNode.connect(sinkGainNode);
  sinkGainNode.connect(audioContext.destination);

  log.debug("Soniox 音訊路徑", { sampleRate, renderQuantum, bufferSize });
}

function buildConfig(apiKey, sampleRate) {
  const endpoint = getSonioxEndpointSettings();
  const langObj = sessionLangObj;

  const config = {
    api_key: apiKey,
    model: SONIOX_MODEL,
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
    language_hints: langObj.deepgramCode === "en" ? ["en", "ja"] : [langObj.deepgramCode, "zh", "en"],
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
  if (sonioxContextCache) config.context = sonioxContextCache;
  return config;
}

/**
 * 接上 Soniox。開始時與每次重連都走這裡；音訊路徑不動。
 * authInfo 省略時重新取臨時 token（臨時 token 有期限，重連時不能沿用開始時那一份）。
 */
async function connectSocket(sessionId, authInfo = null) {
  if (sessionId !== session) return;
  closeSocketSilently();

  const auth = authInfo ?? await fetchSonioxTemporaryToken();
  if (sessionId !== session) return;
  if (!auth?.value) {
    log.warn("重連時取得臨時 Token 失敗");
    scheduleReconnect(sessionId);
    return;
  }

  const ws = new WebSocket(SONIOX_WS_URL);
  socket = ws;
  const isCurrent = () => sessionId === session && socket === ws;

  ws.onopen = () => {
    if (!isCurrent()) return;
    try {
      ws.send(JSON.stringify(buildConfig(auth.value, audioContext?.sampleRate || 16000)));
      isConfigured = true;
      notifyStatusChange("Soniox に接続しました。");

      // 連線前（與斷線期間）存下的音訊補送
      if (pendingAudioChunks.length > 0) {
        log.debug(`補送 ${pendingAudioChunks.length} 塊音訊`);
        for (const chunk of pendingAudioChunks) ws.send(chunk);
        pendingAudioChunks = [];
      }
    } catch (err) {
      log.error("送出設定失敗", err);
      notifyStatusChange("Soniox の設定送信に失敗しました。");
    }
  };

  ws.onmessage = (message) => {
    if (!isCurrent()) return;
    handleSonioxMessage(message, globalOnTranscriptUpdate);
  };

  ws.onclose = () => {
    if (!isCurrent()) return;
    socket = null;
    isConfigured = false;
    log.warn("Soniox 意外斷線，準備重連...");

    // 斷線前還沒送出的部分，這條連線不會再有後續了，當成一句送出（暫定部分一起）。
    // 不送的話，新連線的第一則訊息會把暫定部分蓋掉，那半句就消失了。
    flushSentenceBuffer(globalOnTranscriptUpdate, "🔌 斷線前殘留", 'reconnect');
    scheduleReconnect(sessionId);
  };

  ws.onerror = (e) => {
    if (!isCurrent()) return;
    log.error("Socket 錯誤", e);
    notifyStatusChange("Soniox の接続エラーです。バックエンドまたはネットワークを確認してください。");
  };
}

function scheduleReconnect(sessionId) {
  if (sessionId !== session) return;

  if (retryCount >= MAX_RETRIES) {
    notifyStatusChange("再接続に失敗しました。もう一度「開始」を押してください。");
    stopSoniox({ intentional: false, reason: 'retry-exhausted' });
    return;
  }

  retryCount++;
  notifyStatusChange(`接続が切断されました。再接続しています...`);
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket(sessionId);
  }, RETRY_DELAY_MS);
}

function handleSonioxMessage(message, onTranscriptUpdate) {
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

    // 有結果回來，代表這條連線是活的：重連次數歸零。
    // 不歸零的話，配信中累計斷線 10 次就會放棄。
    // 不在 onopen 歸零：設定被拒時 server 會開了又立刻關，那樣會無限重連。
    retryCount = 0;

    let flushedByEndpoint = false;
    let newNonFinalText = "";
    let addedFinalThisRound = "";
    // 這則訊息是否已計入 finalMsgCount。endpoint 是在迴圈中途就地結算的，
    // 因此必須在加入 token 的當下計數，不能等迴圈跑完。
    let countedThisMessage = false;

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
        flushSentenceBuffer(onTranscriptUpdate, "⚡ endpoint", 'endpoint');
        flushedByEndpoint = true;
        continue;
      }
      if (tokenText === FINISHED_TOKEN) {
        // 串流結束標記，忽略
        continue;
      }

      if (token.is_final) {
        // 診斷用。時間戳走的是音訊時間軸，不是封包抵達時間，因此不受網路抖動影響。
        // 沒帶時間戳的 token 就不記：寧可少一筆，也不要拿錯的時間去算間隔。
        if (typeof token.start_ms === "number" && typeof token.end_ms === "number") {
          finalTokens.push({
            atChar: finalizedText.length,
            startMs: token.start_ms,
            endMs: token.end_ms
          });
        }
        if (!countedThisMessage) {
          finalMsgCount++;
          countedThisMessage = true;
        }

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
    // 只看已確認的長度：暫定部分不會送出，算進去的話可能每則訊息都觸發卻送不出東西。
    if (finalizedText.length >= MAX_BUFFER_LENGTH) {
      flushSentenceBuffer(onTranscriptUpdate, "⚡ 最大長度強制斷", 'maxlen', { keepNonFinal: true });
      if (nonFinalizedText) emitInterim(onTranscriptUpdate);
      return;
    }

    // 一般的 interim 顯示
    emitInterim(onTranscriptUpdate);
  } catch (e) {
    log.error("解析訊息失敗", e);
  }
}

/**
 * 啟動 Soniox 語音辨識服務
 * 回傳 false 時呼叫端會改用 Web Speech API。
 */
export async function startSoniox(langId, onTranscriptUpdate, handlers = {}) {
  setLifecycleHandlers(handlers);
  globalOnTranscriptUpdate = onTranscriptUpdate;
  if (isRunning) return true;

  session += 1;
  const sessionId = session;

  notifyStatusChange('接続しています。しばらくお待ちください...');
  const langObj = getLang(langId);
  if (!langObj) {
    log.error("找不到語系定義:", langId);
    return false;
  }

  const authInfo = await fetchSonioxTemporaryToken();
  if (sessionId !== session) return false;
  if (!authInfo?.value) {
    notifyStatusChange("Soniox の一時トークンを取得できませんでした。Web Speech API に切り替えます...");
    return false;
  }

  await loadSonioxContext();
  if (sessionId !== session) return false;

  sessionLangObj = langObj;
  retryCount = 0;
  pendingAudioChunks = [];
  resetTranscriptBuffers();

  try {
    globalStream = await openMicStream();
    if (sessionId !== session) { cleanupAudioResources(); return false; }
    await buildAudioPipeline(globalStream, sessionId);
    if (sessionId !== session) { cleanupAudioResources(); return false; }
    watchMicEnded(globalStream, sessionId);
  } catch (error) {
    log.error("啟動失敗", error);
    stopSoniox({ intentional: false, reason: 'startup-error' });
    return false;
  }

  isRunning = true;
  lastSpeechTime = Date.now();
  startWatchdog(sessionId);
  connectSocket(sessionId, authInfo);
  return true;
}

export function stopSoniox(options = {}) {
  const intentional = options.intentional !== false;
  const reason = options.reason || (intentional ? 'manual-stop' : 'service-stop');

  // 先讓所有舊的回呼失效，下面的清理途中就不會有重連或音訊插進來。
  session += 1;

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
    const diag = buildSegmentDiag('stop', remainingText.length, 0, finalTokens, finalMsgCount);
    logSegmentDiag("停止前殘留", diag);
    globalOnTranscriptUpdate(remainingText, true, true, { diag });
  }

  isRunning = false;
  retryCount = 0;
  clearReconnectTimer();
  resetTranscriptBuffers();
  lastSpeechTime = 0;
  globalOnTranscriptUpdate = null;
  sessionLangObj = null;

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
