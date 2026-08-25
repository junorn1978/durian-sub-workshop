/**
 * @file speechCapture.js
 * @description 主要處理語音擷取前參數設定到產生逐字稿的相關邏輯。
 * 支援 Web Speech API (免費)、Soniox 兩種辨識引擎。
 */

import { isRayModeActive, getSpeechEngine, browserInfo, getSourceLanguage, getLang, getAlignment } from './config.js';
import { sendTranslationRequest, resetTranslationDisplay } from './translationController.js';
import { startSoniox, stopSoniox } from './sonioxService.js';
import { createLogger } from './logger.js';
import { publishSourceTextToObs, publishTranslationsToObs } from './obsBridge.js';
import { loadKeywordRules, filterRayModeText, processRayModeTranscript } from './rayModeFilter.js';
import { updateStatusDisplay, setRecognitionControlsState, clearAllTextElements, setPauseOverlayState } from './uiState.js';
import { normalizeRecognised } from './normalizeJa.js';
import { getSettingBool, getSettingNumber } from './settingsStore.js';

const log = createLogger('SpeechRecognition');

// #region [狀態變數與快取]

/** @type {boolean} 是否已顯示過麥克風資訊 */
let hasShownMicInfo = false;

/** @type {SpeechRecognition|null} Web Speech API 辨識實例 */
let recognition = null;

/** @type {boolean} 全域辨識啟用狀態 */
let isRecognitionActive = false;
let activeRecognitionEngine = null;

/** @type {Object} 短語庫配置物件 */
let phrasesConfig = {};

/** @type {Map<string, Array<SpeechRecognitionPhrase>>} 已實例化的短語物件快取 */
const cachedPhrases = new Map();

/** @type {string} 存儲上一次發送翻譯的文字，用於上下文比對 */
let previousText = '';

// #endregion

// #region [連續使用上限看門狗]
/**
 * 開始按鍵起算的硬性最大連續使用時長。
 * 防止使用者忘記停止導致雲端 STT 帳單持續累積。
 *
 * 計時起點：按下「開始」按鈕（startSessionWatchdog 被呼叫的時刻）。
 * 重置條件：按下「停止」、引擎自行 onStop、頁面重整。
 * 自動重連（webspeech onend、Soniox retry）不重置。
 */
const SESSION_MAX_DURATION_MS = 5 * 60 * 60 * 1000;
const SESSION_WATCHDOG_INTERVAL_MS = 30 * 1000;

const SESSION_TIMEOUT_MESSAGES = {
  'ja-JP': '強制停止時間に達しました。ページを更新するか、もう一度開始ボタンを押してください。',
  'zh-TW': '已達強制停止時間，請重新整理網頁或重新按下開始按鍵。',
  'en-US': 'Force-stop time reached. Please refresh the page or press the start button again.'
};

let sessionStartTime = 0;
let sessionWatchdogInterval = null;

function isAutoStopEnabled() {
  return getSettingBool('auto-stop-enabled');
}

function startSessionWatchdog() {
  stopSessionWatchdog();
  sessionStartTime = Date.now();
  // 用 Date.now() 比較而非單一 setTimeout(5h)，避免瀏覽器背景分頁節流導致延遲。
  sessionWatchdogInterval = setInterval(checkSessionTimeout, SESSION_WATCHDOG_INTERVAL_MS);
}

function stopSessionWatchdog() {
  if (sessionWatchdogInterval) {
    clearInterval(sessionWatchdogInterval);
    sessionWatchdogInterval = null;
  }
  sessionStartTime = 0;
}

function checkSessionTimeout() {
  if (!isAutoStopEnabled()) return;
  if (!sessionStartTime) return;
  if (Date.now() - sessionStartTime < SESSION_MAX_DURATION_MS) return;
  triggerSessionTimeout();
}

function getTimeoutMessageForLang(langCode) {
  if (!langCode || langCode === 'none') return null;
  return SESSION_TIMEOUT_MESSAGES[langCode] || SESSION_TIMEOUT_MESSAGES['en-US'];
}

function displaySessionTimeoutMessages() {
  const sourceMsg = getTimeoutMessageForLang(document.getElementById('source-language')?.value);
  if (sourceMsg) {
    const sourceEl = document.getElementById('source-text');
    if (sourceEl) sourceEl.textContent = sourceMsg;
    publishSourceTextToObs(sourceMsg);
  }

  const targetSelects = ['target1-language', 'target2-language', 'target3-language'];
  const targetEls = ['target-text-1', 'target-text-2', 'target-text-3'];
  const targetTexts = targetSelects.map((selId, i) => {
    const msg = getTimeoutMessageForLang(document.getElementById(selId)?.value);
    const el = document.getElementById(targetEls[i]);
    if (msg && el) el.textContent = msg;
    return msg || '';
  });
  publishTranslationsToObs(targetTexts);
}

function triggerSessionTimeout() {
  log.warn('連続使用 5 時間に達したため自動停止');
  const engine = activeRecognitionEngine;
  stopSessionWatchdog();
  resetRecognitionState({ clearText: true });
  if (engine === 'soniox') stopSoniox({ reason: 'session-timeout' });
  if (recognition) recognition.abort();
  displaySessionTimeoutMessages();
}
// #endregion

// #region [暫停（附自動恢復）]
/**
 * 暫停是將「停止 → 經過一段時間後開始」自動化。由於會經過與停止相同的流程，
 * 麥克風與 Soniox 連線都會完全釋放，5 小時看門狗也會比照停止處理。
 * 恢復方式有兩種：「開始」按鈕（立即恢復）或等待時間結束。暫停期間按下標誌不會恢復，
 * 而是將剩餘時間重設為設定值（休息時間延長時可再次按下）。
 */
const PAUSE_DURATION_ALLOWED_MIN = [1, 3, 5, 10];
const PAUSE_TICK_INTERVAL_MS = 1000;

/** @type {number} 自動恢復的時間（epoch ms）。若為 0，表示目前並非暫停狀態。 */
let pauseResumeAt = 0;
let pauseResumeTimer = null;
let pauseTickInterval = null;

function isPaused() {
  return pauseResumeAt > 0;
}

/** 設定的暫停時長（ms）。若未設定或數值無效，settingsStore 會回傳預設值。 */
function getPauseDurationMs() {
  return getSettingNumber('pause-duration-min', { allowed: PAUSE_DURATION_ALLOWED_MIN }) * 60 * 1000;
}

function formatRemaining(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 將剩餘時間反映至標誌徽章與字幕欄（OBS 端也顯示相同內容）。 */
function renderPauseCountdown() {
  const remainingText = formatRemaining(pauseResumeAt - Date.now());
  setPauseOverlayState(true, remainingText);

  const message = `一時停止中… 残り ${remainingText}`;
  const sourceEl = document.getElementById('source-text');
  if (sourceEl) sourceEl.textContent = message;
  publishSourceTextToObs(message);
}

/**
 * 解除暫停並返回待機狀態。清除計時器、徽章與剩餘時間顯示（包括 OBS 端）。
 * 恢復時也要先呼叫此函式，再執行 startRecognition()。
 */
function clearPauseState() {
  if (pauseResumeTimer) { clearTimeout(pauseResumeTimer); pauseResumeTimer = null; }
  if (pauseTickInterval) { clearInterval(pauseTickInterval); pauseTickInterval = null; }

  const wasPaused = isPaused();
  pauseResumeAt = 0;
  setPauseOverlayState(false);
  updateSourceText.reset();

  if (wasPaused) {
    clearAllTextElements();
    setRecognitionControlsState('idle');
  }
}

/**
 * 若已超過期限則恢復，否則只更新剩餘時間。
 * 分頁移至背景或被其他視窗遮住時，timer 可能會被節流至數分鐘一次，因此期限判斷一律使用
 * Date.now()，確保無論 setTimeout、setInterval 或 visibilitychange 何者先發生，
 * 都能恢復。
 */
function checkPauseExpiry() {
  if (!isPaused()) return;
  if (Date.now() < pauseResumeAt) {
    renderPauseCountdown();
    return;
  }
  log.info('一時停止の時間が終わったため自動で再開します');
  clearPauseState();
  startRecognition();
}

/** 將自動恢復期限重新設定為從現在起 durationMs 之後。 */
function schedulePauseResume(durationMs) {
  if (pauseResumeTimer) clearTimeout(pauseResumeTimer);
  pauseResumeAt = Date.now() + durationMs;
  pauseResumeTimer = setTimeout(checkPauseExpiry, durationMs);
  renderPauseCountdown();
}

/** 停止辨識，並進入設定時間後自動恢復的狀態。 */
function pauseRecognition() {
  if (!isRecognitionActive || isPaused()) return;

  const durationMs = getPauseDurationMs();
  log.info(`一時停止しました（${durationMs / 60000}分後に自動再開）`);

  stopRecognition('pause');

  setRecognitionControlsState('paused');
  schedulePauseResume(durationMs);
  pauseTickInterval = setInterval(checkPauseExpiry, PAUSE_TICK_INTERVAL_MS);
}

/** 暫停期間按下標誌時的動作。將剩餘時間重設為設定值（不恢復）。 */
function extendPause() {
  if (!isPaused()) return;

  const durationMs = getPauseDurationMs();
  log.info(`一時停止の残り時間を ${durationMs / 60000}分にリセットしました`);
  schedulePauseResume(durationMs);
}
// #endregion

// #region [無聲時清除字幕]
/**
 * 已確認的句子出現後，若經過一段時間仍沒有下一段語音，則清除所有字幕。
 *
 * 已確認的句子是該句最後一次繪製的內容，因此若沒有此機制，
 * 即使休息中也會持續留在直播畫面與 OBS overlay 上，直到有人再次說話。
 *
 * 計時從「確認」開始，而不是從所有辨識事件開始。未確認的 interim
 * 最終仍會在某處被強制斷句並重新繪製，因此若在 interim 階段清除，
 * 只會在清除數秒後再次出現相同句子。等待確認後，
 * 即可在不會再有內容傳來的狀態下清除。
 *
 * 刻意不與翻譯延遲連動。比此時間更晚的翻譯無論如何都已太遲，
 * 保留字幕繼續等待也只是在掩蓋這個事實。
 *
 * final 的判定標準依辨識引擎而異：
 *   - Web Speech：onresult 的 isFinal（以及靜音計時器的強制斷句）
 *   - Soniox：偵測到 endpoint 時進行 flush（shouldTranslate = true）
 * 兩者都是「送出翻譯的瞬間」，因此在該處啟動計時。
 */
let idleClearTimer = null;

/**
 * 設定的無聲字幕清除秒數。若為 0，則保留最後一段字幕。
 *
 * 「未設定」與「設為 0（不清除）」必須分得清楚——Number(null) 不是 NaN 而是 0，
 * 只要直接丟給 Number() 就會把沒動過設定的人整個功能關掉。
 * 這個判斷現在統一由 settingsStore 負責，預設值也只留在那裡一份。
 */
function getClearIdleSec() {
  return getSettingNumber('subtitle-clear-idle-sec', { min: 0 });
}

function cancelIdleClear() {
  if (idleClearTimer) { clearTimeout(idleClearTimer); idleClearTimer = null; }
}

function armIdleClear() {
  cancelIdleClear();
  const seconds = getClearIdleSec();
  if (seconds <= 0) return;
  log.debug(`字幕の自動クリアを ${seconds}秒後に予約`);
  idleClearTimer = setTimeout(() => {
    idleClearTimer = null;
    clearSubtitlesForIdle();
  }, seconds * 1000);
}

/**
 * 一次清除所有字幕欄。previousText 也一併捨棄：經過這麼長的間隔後，
 * 下一句已是不同話題，沿用上一句作為翻譯上下文反而有害。
 */
function clearSubtitlesForIdle() {
  if (!isRecognitionActive || isPaused()) return;
  log.debug(`${getClearIdleSec()}秒無音のため字幕をクリア`);
  resetTranslationDisplay();
  clearAllTextElements();
  updateSourceText.reset();
  previousText = '';
}
// #endregion

// #region [硬體檢測與 UI 控制]

/**
 * 檢測並顯示目前瀏覽器佔用的音訊輸入裝置資訊
 * @async
 * @returns {Promise<void>}
 */
async function showMicInfoOnce() {
  if (hasShownMicInfo) return;
  hasShownMicInfo = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    log.warn('此瀏覽器不支援 mediaDevices.enumerateDevices()');
    return;
  }

  let tempStream = null;
  try {
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      log.warn('取得麥克風權限失敗（名稱可能會顯示為空）:', err);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const micInfoEl = document.getElementById('default-mic');
    if (!audioInputs.length) {
      const msg = 'マイクが見つかりません';
      log.info(msg);
      if (micInfoEl) setMicLabel(micInfoEl, `🎙️ ${msg}`);
      return;
    }

    const defaultDevice = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0];
    const micName = defaultDevice.label || 'デバイス名を取得できませんでした';

    log.info('偵測到的裝置列表:', audioInputs);
    if (micInfoEl) {
      setMicLabel(micInfoEl, `🎙️ ${micName}`);
      micInfoEl.title = micName;
    }
  } catch (err) {
    log.error('取得麥克風資訊失敗:', err);
  } finally {
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
  }
}

/**
 * 設定狀態列的麥克風名稱。僅在無法容納於寬度（205px）時，以新聞跑馬燈形式
 * 無縫循環捲動；若能容納則靜止顯示（CSS 請參閱 .status-mic）。
 * @param {HTMLElement} el #default-mic 元素
 * @param {string} text 顯示文字
 */
function setMicLabel(el, text) {
  if (!el) return;
  el.classList.remove('is-marquee');
  el.textContent = text; // 預設為靜止顯示（若無法容納，則在下方改為跑馬燈）

  const activate = () => {
    if (el.scrollWidth <= el.clientWidth) return; // 若能容納則維持靜止

    // 溢位時：並列兩份相同文字，使其無縫循環
    el.textContent = '';
    const track = document.createElement('span');
    track.className = 'mic-track';
    const first = document.createElement('span');
    first.className = 'mic-seg';
    first.textContent = text;
    const second = document.createElement('span');
    second.className = 'mic-seg';
    second.setAttribute('aria-hidden', 'true');
    second.textContent = text;
    track.append(first, second);
    el.appendChild(track);
    el.classList.add('is-marquee');

    requestAnimationFrame(() => {
      const GAP_PX = 32;     // 必須與 CSS .mic-track 的 gap 一致
      const SPEED_PX_S = 45; // 捲動速度（px／秒）
      const shift = first.offsetWidth + GAP_PX;
      track.style.setProperty('--mic-shift', `${shift}px`);
      track.style.setProperty('--mic-duration', `${(shift / SPEED_PX_S).toFixed(1)}s`);
    });
  };

  // 為避免自訂字型造成寬度偏差，待字型確定後再測量
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => requestAnimationFrame(activate));
  } else {
    requestAnimationFrame(activate);
  }
}

/**
 * 是否正在以 Web Speech API 引擎進行辨識
 * @returns {boolean}
 */
function isWebSpeechRecognitionRunning() {
  return isRecognitionActive && activeRecognitionEngine === 'webspeech';
}

function resetRecognitionState({ clearText = false } = {}) {
  cancelIdleClear();
  setRecognitionControlsState('idle');
  isRecognitionActive = false;
  activeRecognitionEngine = null;
  if (clearText) {
    resetTranslationDisplay();
    clearAllTextElements();
  }
}

// #endregion

// #region [語音辨識核心配置]

/**
 * 初始化 Web Speech API Recognition 參數
 * @async
 * @param {SpeechRecognition} recognition - 辨識實例
 * @throws {Error} 若未選擇語系則中斷執行
 */
async function configureRecognition(recognition, sourceLanguage) {

  const processLocallyStatus = await decideProcessLocally(sourceLanguage);

  /* 
   * [注意] Web Speech API On-Device 模式目前僅 Chrome 支援。
   * 若 recognition.processLocally 設為 false，則無法使用自訂語句 (phrases)，強制使用會導致錯誤。
   * 
   * 目前設定：當 recognition.processLocally = true 且為 Chrome 時，recognition.continuous 設為 true。
   * 這是為了避免 onend 事件重啟期間若使用者仍在說話導致辨識中斷。
   */
  if (browserInfo.isChrome) { recognition.processLocally = processLocallyStatus; }

  recognition.interimResults = true;
  recognition.lang = sourceLanguage;
  /*
   * [關於 continuous 參數]
   * 只在「沒有連線可以掉」的情況下才開 continuous，也就是 On-Device 模式。
   *
   * 雲端辨識的 socket 大約一分鐘就會自己斷掉。在 Edge 上觀察到的狀況是：
   * 早就停止回傳結果了，好幾秒後才丟出 network error，中間講的話全部消失，
   * 而且沒有任何事件可以反應。改成每句一個 session (continuous = false) 之後，
   * 收尾交還給引擎自己的斷句判斷——它是在剛偵測到的停頓處關閉，
   * 重啟成本約 200ms 也落在同一個停頓裡。
   * On-Device 模型沒有連線可掉，整場不中斷。
   */
  recognition.continuous = processLocallyStatus;
  recognition.maxAlternatives = 1;

  if ('phrases' in recognition) {
    const usePhrases = browserInfo.isChrome && recognition.processLocally;
    const selectedPhrases = usePhrases ? getPhrasesForLang(sourceLanguage) : [];
    recognition.phrases = selectedPhrases.length > 0 ? selectedPhrases : [];
  }

  log.debug('辨識參數已就緒:', {
    lang: recognition.lang,
    processLocally: recognition.processLocally,
    phrasesCount: recognition.phrases?.length ?? 0,
    continuous: recognition.continuous
  });
}

/**
 * 處理來自雲端 STT 服務 (Soniox) 的串流回傳值
 * @param {string} text - 目前完整的顯示文字
 * @param {boolean} isFinal - 是否為確認文字
 * @param {boolean} shouldTranslate - 是否觸發翻譯請求
 * @param {string} currentLang - 當前語言代碼
 * @param {string} symbolType - 'soniox' (用於裝飾符號)
 */
async function handleCloudTranscript(text, isFinal, shouldTranslate, currentLang, symbolType) {

  let processedText = isRayModeActive() ? processRayModeTranscript(text, currentLang) : text;
  const textToTranslate = processedText.trim();

  if (!isFinal) { processedText = wrapWithNoteByAlignment(processedText, symbolType); }
  if (processedText.trim() !== '') { updateSourceText(processedText.replace(/[、。？\s]+/g, ' ').trim()); }

  // 尚在說話時不要清除。Soniox 的 final 標準是偵測到 endpoint 時進行
  // flush，因此其他訊息一律視為中途結果。
  if (!shouldTranslate && processedText.trim() !== '') { cancelIdleClear(); }

  if (shouldTranslate && processedText.trim() !== '') {
    if (textToTranslate) {
      log.info(`收到 ${symbolType} 指令，執行翻譯:`, textToTranslate);

      sendTranslationRequest(textToTranslate, previousText, currentLang);
      previousText = textToTranslate;
      updateSourceText(textToTranslate.replace(/[、。？\s]+/g, ' ').trim());
      armIdleClear();
      return;
    }
  }
}

// #endregion

// #region [規則載入與文字過濾]

/**
 * 載入辨識語句權重 (Phrases) 配置
 * [注意] 此功能需 Chrome 141+ 且透過 install 方式安裝的 Web App 才支援。
 * 目前若未滿足條件會導致錯誤，故程式碼中暫未全面啟用，保留供未來使用。
 */
async function loadPhrasesConfig() {
  try {
    const response = await fetch('data/phrases_config.json');
    if (!response.ok) throw new Error('無法載入 phrases 配置');

    phrasesConfig = await response.json();
    Object.keys(phrasesConfig.languages || {}).forEach(lang => {
      const langData = phrasesConfig.languages[lang] || [];
      let phraseObjects = [];
      if (typeof SpeechRecognitionPhrase !== 'undefined') {
        phraseObjects = langData.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost));
      }
      cachedPhrases.set(lang, phraseObjects);
    });

    if (phrasesConfig.defaults && typeof SpeechRecognitionPhrase !== 'undefined') {
      cachedPhrases.set('default', phrasesConfig.defaults.map(p => new SpeechRecognitionPhrase(p.phrase, p.boost)));
    }
  } catch (error) {
    log.error('載入短語配置失敗:', error);
    phrasesConfig = { languages: {} };
  }
}

/** 獲取快取的語言短語 */
function getPhrasesForLang(sourceLang) {
  return cachedPhrases.get(sourceLang) || cachedPhrases.get('default') || [];
}

/**
 * 偵測瀏覽器是否支援本地辨識模式。
 * On-Device (SODA) 只有 Chrome 有，Edge 一律走雲端辨識。
 * 回傳值同時決定 recognition.continuous，詳見 configureRecognition()。
 */
async function decideProcessLocally(lang) {
  if (!browserInfo.isChrome) return false;
  if (!('SpeechRecognition' in window) || !SpeechRecognition.available) return false;
  try {
    const status = await SpeechRecognition.available({ langs: [lang], processLocally: true });
    return status === 'available';
  } catch (e) {
    return false;
  }
}

// #endregion

// #region [UI 更新與顯示邏輯]

/**
 * 更新字幕顯示區域
 * @param {string} text - 辨識文字
 */
const updateSourceText = (() => {
  let el = null;
  let lastRenderedText = '';

  const render = (text) => {
    if (!el) {
      el = document.getElementById('source-text');
      if (!el) return;
    }
    if (!text || text.trim().length === 0 || text === '。') return;
    if (text === lastRenderedText) { return; }
    el.textContent = text;
    lastRenderedText = text;
    publishSourceTextToObs(text);
  };

  /* 顯示暫停剩餘時間等未經此函式直接改寫元素後呼叫。
     若不呼叫，恢復後的第一句辨識結果與停止前相同時，會因重複判定而不顯示。 */
  render.reset = () => { lastRenderedText = ''; };

  return render;
})();

/**
 * 根據視覺對齊方式添加動態音符裝飾
 * @param {string} baseText 
 * @returns {string} 裝飾後的文字
 */
function wrapWithNoteByAlignment(baseText, symbolType) {
  const alignment = getAlignment();
  // soniox api              → 🐹
  // web speech api → Chrome → 🐿️
  // web speech api → Edge   → 🐭
  const symbolTextA = symbolType === 'soniox' ? '​​🐹'
                         : browserInfo.isChrome ? '​​🐿️'
                                                : '​🐭';
  const symbolTextB = '🐹';

  return alignment === 'center' ? `${symbolTextA}${baseText}${symbolTextB}`
       : alignment === 'right'  ? `${symbolTextA}${baseText}`
                                : `${baseText}${symbolTextA}`;
}

// #endregion

// #region [語音辨識控制流程]

/**
 * 初始化語音辨識實體與生命週期事件
 * @returns {SpeechRecognition|null}
 */
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition;
  if (!SpeechRecognition) return null;

  const newRecognition = new SpeechRecognition();



  const SILENCE_THRESHOLD = 10000;
  let silenceTimer = null;

  let finalTranscript = '';
  let interimTranscript = '';

  /* 啟動看門狗。聲音已經進到辨識端，但一直沒有任何結果回來，就重啟一次賭下一場正常。
     這不是「模型可能比較慢」的寬限時間——健康的 On-Device 模型在 onsoundstart 之後
     約 1ms 就會給出第一筆結果。它存在的理由是：剛裝完語言包的那一場幾乎必定是死的，
     available() 說就緒、實際上完全不吐東西，靠這裡的重啟才會開始動。
     所以時間要短：對健康模型的餘裕本來就大得誇張，多等的每一秒都是使用者
     裝完語言包之後乾等的空白。
     跨越多次重啟仍然沉默的模型不是這裡救得了的，那種要把語言包刪掉重裝
     （而且要先關掉瀏覽器的行程，否則檔案是鎖住的）。
     觸發時不送任何東西：還沒有結果就沒有東西可以送，送半個詞去翻譯只會更糟。
     continuous 就代表 On-Device，也就代表 Chrome（見 decideProcessLocally），
     所以判斷 continuous 一個條件就夠。 */
  const STARTUP_TIMEOUT = 3000;
  let startupTimer = null;
  let resultCount = 0;

  const clearStartupTimer = () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  };

  // 斷句計時器。
  // 這是「session 不會自己結束」時的最後保險，所以只有 continuous 才需要。
  // 每句一個 session 的情況下，引擎自己的斷句已經會關閉 session，
  // 這裡再加一道只會跟它互相搶——Edge 與 Chrome 的雲端辨識現在都屬於後者。
  // 舊的判斷式寫的是 isChrome，那是 Chrome 還一律 continuous 時代的寫法，
  // 它真正想描述的條件其實是 continuous。
  const resetSilenceTimer = () => {
    if (!newRecognition.continuous) return;

    if (silenceTimer) clearTimeout(silenceTimer);

    // 設定新的計時器
    silenceTimer = setTimeout(() => {
      log.debug(`偵測到靜音超過 ${SILENCE_THRESHOLD}ms，強制重啟`);

      if (interimTranscript.trim().length > 0) {
        let forcedFinalText = normalizeRecognised(
          interimTranscript.replace(/[、。？\s]+/g, ' ').trim(), newRecognition.lang);
        
        if (isRayModeActive()) {
           forcedFinalText = processRayModeTranscript(forcedFinalText, newRecognition.lang);
        }

        if (forcedFinalText) {
          log.info('(強制斷句) 發送翻譯請求文字:', forcedFinalText);
          sendTranslationRequest(forcedFinalText, previousText, newRecognition.lang);
          previousText = forcedFinalText;
          updateSourceText(forcedFinalText);
          // 此強制斷句即為本句的 final。由於不會經過 onresult，若不在此處啟動計時，
          // 傳入的字幕便會持續顯示而不消失。
          armIdleClear();
        }
      }
      newRecognition.abort(); 

    }, SILENCE_THRESHOLD);
  };

  newRecognition.onstart = () => {
    resultCount = 0;
    clearStartupTimer();
  };

  newRecognition.onsoundstart = () => {
    log.debug('soundstart事件觸發');
    if (!newRecognition.continuous || resultCount > 0) return;
    clearStartupTimer();
    startupTimer = setTimeout(() => {
      log.warn(`啟動看門狗觸發：${STARTUP_TIMEOUT}ms 內沒有任何辨識結果，重新啟動`);
      newRecognition.abort();
    }, STARTUP_TIMEOUT);
  };

  newRecognition.onresult = async (event) => {
    resultCount++;
    clearStartupTimer();
    let hasFinalResult = false;
    interimTranscript = '';
    finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
        hasFinalResult = true;
      } else {
        interimTranscript += transcript;
      }
    }

    // 用「本次事件實際帶進來的 interim」來決定要不要重新計時。
    // 寫在解析迴圈之前的話，判斷依據會是上一輪殘留的值，
    // 結果一場辨識的第一筆結果永遠不會啟動計時器。
    if (interimTranscript.trim().length > 0) { resetSilenceTimer(); }

    if (hasFinalResult && finalTranscript.trim().length > 0) {
      let sendTranslationRequestText = normalizeRecognised(
        finalTranscript.replace(/[、。？\s]+/g, ' ').trim(), newRecognition.lang);
      if (isRayModeActive()) { sendTranslationRequestText = filterRayModeText(sendTranslationRequestText, newRecognition.lang); }

      log.info('發送翻譯請求文字:', sendTranslationRequestText);
      sendTranslationRequest(sendTranslationRequestText, previousText, newRecognition.lang);
      previousText = sendTranslationRequestText;
    }

    const fullTextRaw = normalizeRecognised(
      `${finalTranscript} ${interimTranscript}`.replace(/[、。？\s]+/g, ' ').trim(), newRecognition.lang);
    let processedText = isRayModeActive() ? processRayModeTranscript(fullTextRaw, newRecognition.lang) : fullTextRaw;

    if (!hasFinalResult && processedText.trim() !== '') { processedText = wrapWithNoteByAlignment(processedText, 'webspeech'); }
    if (processedText.trim() !== '') { updateSourceText(processedText); }

    // interim 優先。一個事件可能同時帶有 final（剛結束的句子）與 interim（下一句已開始傳入），
    // 而正在說話的狀態永遠優先。判斷應使用原始 transcript，而非過濾後的內容：
    // 被關鍵字規則移除的詞只會使顯示變空，但人仍在說話。
    if (interimTranscript.trim().length > 0) cancelIdleClear();
    else if (hasFinalResult) armIdleClear();
  };

  newRecognition.onnomatch = () => { log.warn('無匹配辨識結果'); };
  newRecognition.onend = () => {
    clearStartupTimer();
    if (silenceTimer) clearTimeout(silenceTimer);
    log.debug('onend事件觸發');
    
    finalTranscript = '';
    interimTranscript = '';
    autoRestartRecognition();
  }
  newRecognition.onerror = (event) => {
    clearStartupTimer();
    if (silenceTimer) clearTimeout(silenceTimer);
    if (event.error !== 'aborted') log.error('辨識錯誤:', event.error);
  };

  return newRecognition;
}

/**
 * 處理 Web Speech API 的斷線自動重連機制
 * @async
 * @param {Object} options 
 */
async function autoRestartRecognition(options = { delay: 0 }) {
  if (!isRecognitionActive) return;

  setTimeout(async () => {
    try {
      recognition.start();
      options.delay = 0;
    } catch (error) {
      // 前一個實體還在收尾時 start() 會丟例外。延遲以 200ms 遞增 (上限 1000ms) 後重試，
      // 等待交給外層的 setTimeout，這裡直接遞迴才不會疊出兩層計時器。
      if (options.delay < 1000) options.delay += 200;
      autoRestartRecognition(options);
    }
  }, options.delay);
}

// #endregion

// #region [事件掛載與生命週期]

/** 開始按鈕的處理內容。從暫停狀態恢復也會經過相同流程。 */
async function startRecognition() {
  updateStatusDisplay('');
  const sourceLang = await getSourceLanguage();
  if (!sourceLang) {
    updateStatusDisplay('音声認識を開始する前に、音声認識言語を選択してください。');
    return;
  }

  resetTranslationDisplay();
  clearAllTextElements();
  updateSourceText.reset();

  /* 雲端 STT 優先權邏輯：若選擇雲端引擎則嘗試啟動，失敗後 Fallback 至 Web Speech API */
  const engine = getSpeechEngine();
  if (engine === 'soniox') {
    try {
      const sonioxStarted = await startSoniox(sourceLang, (text, isFinal, shouldTranslate) => {
        handleCloudTranscript(text, isFinal, shouldTranslate, sourceLang, 'soniox');
      }, {
        onStatusChange: updateStatusDisplay,
        onStop: () => {
          resetRecognitionState({ clearText: true });
          stopSessionWatchdog();
        }
      });
      if (sonioxStarted) {
        setRecognitionControlsState('recording');
        isRecognitionActive = true;
        activeRecognitionEngine = 'soniox';
        startSessionWatchdog();
        return;
      }
    } catch (err) {
      log.error('Soniox 啟動失敗:', err);
    }
  }

  setRecognitionControlsState('recording');
  isRecognitionActive = true;
  await configureRecognition(recognition, sourceLang);
  try {
    recognition.start();
    activeRecognitionEngine = 'webspeech';
    startSessionWatchdog();
  } catch (error) {
    setRecognitionControlsState('idle');
    isRecognitionActive = false;
    activeRecognitionEngine = null;
  }
}

/** 停止按鈕的處理內容。暫停也會經過相同流程（完全釋放麥克風與連線）。 */
function stopRecognition(reason = 'manual-stop') {
  // resetRecognitionState 會把 activeRecognitionEngine 清成 null，
  // 所以要先抓住目前的引擎再 reset。
  const engine = activeRecognitionEngine;
  stopSessionWatchdog();
  resetRecognitionState({ clearText: true });
  if (engine === 'soniox') stopSoniox({ reason });
  if (recognition) recognition.abort();
}

/** 綁定 UI 操作按鈕與語音服務啟動邏輯 */
function setupSpeechRecognitionHandlers() {
  if (!window.SpeechRecognition || browserInfo.browser === 'Unknown') return;

  recognition = setupSpeechRecognition();
  if (!recognition) return;

  const [startButton, stopButton, pauseButton] =
    ['start-recording', 'stop-recording', 'pause-recording'].map(id => document.getElementById(id));

  startButton.addEventListener('click', async () => {
    clearPauseState();
    await startRecognition();
  });

  stopButton.addEventListener('click', () => {
    // 暫停期間的停止代表「取消自動恢復」。辨識已經停止。
    if (isPaused()) {
      log.info('一時停止を取り消しました（自動再開なし）');
      clearPauseState();
      return;
    }
    stopRecognition();
  });

  // 暫停期間按下標誌代表「重設剩餘時間」。恢復僅交由「開始」按鈕處理。
  pauseButton?.addEventListener('click', () => {
    if (isPaused()) {
      extendPause();
      return;
    }
    pauseRecognition();
  });
}

/** 頁面初始化與卸載處理 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadKeywordRules();
  await loadPhrasesConfig();
  setupSpeechRecognitionHandlers();
  setRecognitionControlsState('idle');
  setPauseOverlayState(false);
  isRecognitionActive = false;
  activeRecognitionEngine = null;

  showMicInfoOnce().catch(() => { });

  // 若在受節流的 timer 觸發前回到前景，則在此偵測期限已到並恢復。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPauseExpiry();
  });

  window.addEventListener('beforeunload', () => {
    if (activeRecognitionEngine === 'soniox') stopSoniox();
    // OBS 的 overlay 是另一個頁面，因此剩餘時間顯示可能會停住而不消失。
    if (isPaused()) publishSourceTextToObs('');
  });
});

// #endregion

export { isWebSpeechRecognitionRunning };
