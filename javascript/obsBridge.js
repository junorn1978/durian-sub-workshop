/**
 * @file obsBridge.js
 * @description 直接連上 OBS WebSocket（obs-websocket v5）的橋接層。只送不收。
 *
 * 【資料怎麼走到 OBS 畫面上】
 * 本模組並不去改 OBS 裡的文字來源。字幕是這樣傳的：
 *
 *   index.html ──op 6 BroadcastCustomEvent──▶ OBS ──op 5 Event──▶ obs_overlay.html
 *                                          （中繼）              （OBS 的瀏覽器來源）
 *
 * 也就是把 OBS 當成訊息中繼站：這裡廣播一個 type 為 'hamham_subtitle_update'
 * 的自訂事件，跑在 OBS 瀏覽器來源裡的 obs_overlay.html 收到後自己畫字幕。
 * 好處是字幕的樣式與換行完全由網頁決定，不受 OBS 文字來源的能力限制。
 *
 * 因為只負責送，這一端的 eventSubscriptions 是 0（不訂閱任何 OBS 事件）；
 * 反過來 obs_overlay.html 那端會用 eventSubscriptions: 1 來收 CustomEvent。
 *
 * 【op（opcode）對照】協定裡的訊息種類，本檔案只用到這五個：
 *   0 Hello           OBS 連上後主動送來，內含認證用的 salt／challenge
 *   1 Identify        我方回送的登入訊息（帶認證 token 與訂閱設定）
 *   2 Identified      登入成功。收到這個之後才能開始送 Request
 *   6 Request         送出一個請求（BroadcastCustomEvent、CreateInput…）
 *   7 RequestResponse 對應 op 6 的回覆，用 requestId 配對
 * 規格：https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */

import { getSetting, getSettingBool } from './settingsStore.js';
import { createLogger } from './logger.js';

const log = createLogger('OBSBridge');

const OBS_ENABLED_KEY = 'obs-ws-enabled';
const OBS_IP_KEY = 'obs-ws-ip';
const OBS_PORT_KEY = 'obs-ws-port';
const OBS_PASSWORD_KEY = 'obs-ws-password';

const RECONNECT_DELAY_MS = 2000;

let socket = null;
let reconnectTimer = null;
let currentUrl = '';
let currentPassword = '';
let authenticated = false;
let requestCounter = 0;

/* 最後一次的字幕內容。斷線重連後不必等下一句話，直接用這份重送即可。 */
let latestSourceText = '';
let latestTranslations = ['', '', ''];

/* 認證完成前送來的字幕先記在這裡，等收到 op 2 Identified 再由 flushPendingPushes() 補送。
   開始辨識與連上 OBS 是各自獨立的時序，沒有這層緩衝就會漏掉最前面幾句。 */
let pendingSourcePush = false;
let pendingTranslationPush = false;

let lastStatusText = '';

// --- OBS Auto Setup Feature ---

let pendingAutoSetup = false;

function generateObsOverlayUrl(mode) {
  const baseUrl = window.location.href.split('?')[0].replace(/index\.html$/, '').replace(/\/$/, '');
  const url = getObsUrl();
  const pwd = getPassword();
  const modeParam = mode && mode !== 'all' ? `&mode=${encodeURIComponent(mode)}` : '';
  return `${baseUrl}/obs_overlay.html#url=${encodeURIComponent(url)}&pwd=${encodeURIComponent(pwd)}${modeParam}`;
}

/**
 * 更新可拖曳到 OBS 來源清單的連結。
 * 連結要顯示哪一種字幕，由 HTML 的 data-obs-mode 決定（all／source／target1…）。
 */
export function refreshObsDragLinks() {
  document.querySelectorAll('[data-obs-mode]').forEach(link => {
    link.href = generateObsOverlayUrl(link.dataset.obsMode);
  });
}

/**
 * 「OBS に字幕ソースを追加」按鈕的入口。
 * 尚未連線時先記下需求並開始連線，等認證完成由 flushPendingPushes() 接手執行。
 */
export function triggerAutoSetup() {
  if (!isEnabled()) {
    alert("先に「OBS WebSocket」を有効にしてください。");
    return;
  }
  if (!authenticated) {
    alert("OBS WebSocket に接続されていません。サーバーIP、ポート、パスワードを確認してください。接続でき次第、字幕ソースを追加します。");
    pendingAutoSetup = true;
    ensureConnection();
    return;
  }
  executeAutoSetup();
}

/**
 * 送出一個 op 6 Request 並等待對應的 op 7 RequestResponse。
 * 協定沒有請求與回覆的通道概念，只靠 requestId 配對，因此這裡自己掛一個
 * message 監聽器過濾出屬於自己的回覆，收到後立刻移除。
 * 若 OBS 因故不回覆，5 秒後以逾時 reject，避免監聽器與 Promise 永遠留著。
 * @param {string} requestType - 協定的請求名稱（GetCurrentProgramScene、CreateInput…）
 * @param {Object} [requestData]
 * @returns {Promise<Object>} responseData
 */
function sendSingleRequest(requestType, requestData) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Socket not open"));
      return;
    }
    const requestId = `hamu-req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const listener = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.op === 7 && msg.d.requestId === requestId) {
          socket.removeEventListener('message', listener);
          if (msg.d.requestStatus.result) {
              resolve(msg.d.responseData);
          } else {
              reject(new Error(msg.d.requestStatus.comment || "Request failed"));
          }
        }
      } catch (_) {
        // 同一條連線上還有別的訊息（其他請求的回覆等），解析不了的直接略過。
      }
    };
    
    socket.addEventListener('message', listener);
    
    sendRaw({
      op: 6,
      d: {
        requestType: requestType,
        requestId: requestId,
        requestData: requestData
      }
    });
    
    setTimeout(() => {
        socket.removeEventListener('message', listener);
        reject(new Error(`Request ${requestType} timeout`));
    }, 5000);
  });
}

/**
 * 在使用者目前的場景裡建立（或修復）五個字幕用的瀏覽器來源。
 *
 * 流程是「先嘗試建立，失敗就當作已存在並改為修復」：
 * OBS 的來源名稱是全域唯一的，若使用者曾在別的場景加過同名來源，CreateInput
 * 會失敗。這時不能就此放棄——來源存在，但可能不在目前場景、網址也可能是舊的
 * （改過 IP 或密碼），所以接著做三件事：加進目前場景、更新網址設定、套用預設顯示狀態。
 *
 * 只有「全体表示」預設為顯示，其餘四個建立後隱藏，讓使用者自行決定要不要拆開排版。
 */
async function executeAutoSetup() {
  try {
    const currentSceneResponse = await sendSingleRequest('GetCurrentProgramScene');
    const mainSceneName = currentSceneResponse.currentProgramSceneName || currentSceneResponse.sceneName || currentSceneResponse.sceneUuid;
    if (!mainSceneName) throw new Error("現在のシーン名を取得できませんでした");

    log.debug(`自動設定開始。對象シーン: ${mainSceneName}`);

    const sourcesToCreate = [
      { name: 'HamHam字幕-全体表示', mode: 'all', visible: true },
      { name: 'HamHam字幕-音声', mode: 'source', visible: false },
      { name: 'HamHam字幕-翻訳1', mode: 'target1', visible: false },
      { name: 'HamHam字幕-翻訳2', mode: 'target2', visible: false },
      { name: 'HamHam字幕-翻訳3', mode: 'target3', visible: false }
    ];

    for (const source of sourcesToCreate) {
      try {
        const url = generateObsOverlayUrl(source.mode);
        await sendSingleRequest('CreateInput', {
          sceneName: mainSceneName,
          inputName: source.name,
          inputKind: 'browser_source',
          inputSettings: {
            url: url,
            width: 1280,
            height: 200,
            reroute_audio: false,
            css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }'
          },
          sceneItemEnabled: source.visible
        });
        log.debug(`已在目前場景建立來源: ${source.name}`);
      } catch (e) {
        log.debug(`來源 ${source.name} 無法建立，多半是已經存在，改走修復流程。原因:`, e.message);
        
        try {
          // 既然來源已經存在於 OBS 中，我們需要確保它有被加進「當前場景」
          try {
             await sendSingleRequest('CreateSceneItem', {
                sceneName: mainSceneName,
                sourceName: source.name
             });
             log.debug(`已將既有來源 ${source.name} 加入目前場景`);
          } catch(errAdd) {
             // 如果加入失敗，通常是因為它「已經在這個場景裡了」，這是可以接受的
          }

          // 更新它的設定 (網址可能變了、密碼可能變了)
          await sendSingleRequest('SetInputSettings', {
            inputName: source.name,
            inputSettings: {
              url: generateObsOverlayUrl(source.mode),
              width: 1280,
              height: 200,
              css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }'
            }
          });
          
          // 顯示狀態要透過 sceneItemId 設定，因此得先查出這個來源在場景中的 id。
          const idRes = await sendSingleRequest('GetSceneItemId', {
              sceneName: mainSceneName,
              sourceName: source.name
          });
          
          await sendSingleRequest('SetSceneItemEnabled', {
              sceneName: mainSceneName,
              sceneItemId: idRes.sceneItemId,
              sceneItemEnabled: source.visible
          });
          log.debug(`既有來源已更新: ${source.name}`);
        } catch(err2) {
          log.error(`來源 ${source.name} 無法修復:`, err2.message);
        }
      }
    }

    alert("現在のシーンに5つの字幕ソースを追加しました。\n初期状態では「全体表示」のみ表示されます。必要に応じて、各ソースの配置やグループ分けを調整してください。");

  } catch (error) {
    log.error("自動設定失敗:", error);
    alert("OBSへの字幕ソースの追加に失敗しました。\n" + error.message);
  }
}

// ------------------------------


function isEnabled() {
  return getSettingBool(OBS_ENABLED_KEY);
}

function getObsUrl() {
  // 使用者可能連 scheme 一起貼進來（wss://…），因此再正規化一次。
  const ip = getSetting(OBS_IP_KEY).trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '') || '127.0.0.1';
  const port = getSetting(OBS_PORT_KEY).trim() || '4455';
  return `ws://${ip}:${port}`;
}

function getPassword() {
  return getSetting(OBS_PASSWORD_KEY).trim();
}

function normalizeTranslations(translations) {
  const arr = Array.isArray(translations) ? translations : [];
  return [arr[0] || '', arr[1] || '', arr[2] || ''];
}

/**
 * 記錄橋接狀態。相同訊息只輸出一次，避免重連迴圈把主控台洗版。
 * 狀態字串是寫給人看的、不是列舉，因此以關鍵字判斷是不是錯誤：
 * 是的話用 error（關閉日誌時也看得到），其餘的連線過程細節降到 debug。
 */
function setBridgeStatus(text) {
  if (!text || text === lastStatusText) return;
  lastStatusText = text;
  const lowered = text.toLowerCase();
  const isError =
    lowered.includes('error') ||
    lowered.includes('failed') ||
    lowered.includes('disconnected') ||
    lowered.includes('code=4');
  if (isError) log.error(text);
  else log.debug(text);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function safeCloseSocket() {
  if (!socket) return;
  try {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  } catch (_) {
    // socket 早就壞了才會走到這裡，close() 再拋一次也沒有意義；
    // 下面照樣把狀態歸零，讓重連流程從乾淨的狀態開始。
  }
  socket = null;
  authenticated = false;
  pendingSourcePush = false;
  pendingTranslationPush = false;
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnection();
  }, RECONNECT_DELAY_MS);
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sha256Base64(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return toBase64(new Uint8Array(hashBuffer));
}

/**
 * 依 obs-websocket v5 規格算出認證 token。
 * 公式固定為兩層 sha256 + base64，順序不能調換：
 *
 *   secret = base64(sha256(password + salt))
 *   token  = base64(sha256(secret + challenge))
 *
 * salt 與 challenge 都來自 op 0 Hello。challenge 每次連線都不同，
 * 因此 token 不能快取，每次重連都要重算。
 * @returns {Promise<string>} 三個參數缺任一個時回傳空字串（視為不需認證）
 */
async function buildAuthToken(password, salt, challenge) {
  if (!password || !salt || !challenge) return '';
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

function sendRaw(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (_) {
    // 送不出去就算了：字幕會在下一句或重連後重送，不值得為此中斷辨識流程。
  }
}

/** 回覆 op 1 Identify 完成登入。未設定密碼時 authentication 留空即可。 */
function sendIdentify(authentication = '') {
  const identifyData = {
    rpcVersion: 1,
    // 0 = 不訂閱任何事件。本模組只送不收，訂閱只會白白收到大量 OBS 事件。
    // （obs_overlay.html 那端相反，它要收 CustomEvent，所以用 1。）
    eventSubscriptions: 0
  };
  if (authentication) identifyData.authentication = authentication;
  sendRaw({ op: 1, d: identifyData });
}

function pushSourceToObs() {
  if (!authenticated) {
    pendingSourcePush = true;
    return;
  }
  pendingSourcePush = false;
  broadcastSubtitleUpdate();
}

function pushTranslationsToObs() {
  if (!authenticated) {
    pendingTranslationPush = true;
    return;
  }
  pendingTranslationPush = false;
  broadcastSubtitleUpdate();
}

function getStyleFor(prefix) {
  const colorEl = document.getElementById(`${prefix}-font-color`);
  const strokeColorEl = document.getElementById(`${prefix}-font-stroke-color`);
  const sizeEl = document.getElementById(`${prefix}-font-size`);
  const strokeSizeEl = document.getElementById(`${prefix}-font-stroke-size`);
  return {
    color: colorEl ? colorEl.value : '#FFFFFF',
    strokeColor: strokeColorEl ? strokeColorEl.value : '#000000',
    fontSize: sizeEl ? `${sizeEl.value}px` : '20px',
    strokeSize: strokeSizeEl ? `${strokeSizeEl.value}px` : '4px'
  };
}

function getLanguageFor(prefix) {
  const langEl = document.getElementById(`${prefix}-language`);
  const lang = langEl ? langEl.value : '';
  return lang && lang !== 'none' ? lang : '';
}

/**
 * 把目前的字幕內容與外觀整包廣播出去（op 6 BroadcastCustomEvent）。
 *
 * 每次都送完整快照而非差異，因為 overlay 可能是中途才被 OBS 載入的，
 * 收到第一則事件就要能畫出正確畫面。樣式、語言、對齊方式都直接從設定 UI 的
 * DOM 元素讀取，讓 overlay 端不必自己保存任何設定。
 */
function broadcastSubtitleUpdate() {
  if (!authenticated) return;
  requestCounter += 1;
  
  let alignment = 'center';
  const alignRadios = document.getElementsByName('alignment');
  if (alignRadios) {
    for (const radio of alignRadios) {
      if (radio.checked) {
        alignment = radio.value;
        break;
      }
    }
  }

  const sourceEl = document.getElementById('source-text');

  const sourceClasses = sourceEl ? Array.from(sourceEl.classList).filter(c => c.startsWith('visual-')) : [];

  sendRaw({
    op: 6,
    d: {
      requestType: 'BroadcastCustomEvent',
      requestId: `hamu-broadcast-${requestCounter}`,
      requestData: {
        eventData: {
          type: 'hamham_subtitle_update',
          source: latestSourceText || '',
          target1: latestTranslations[0] || '',
          target2: latestTranslations[1] || '',
          target3: latestTranslations[2] || '',
          alignment: alignment,
          langs: {
            source: getLanguageFor('source'),
            target1: getLanguageFor('target1'),
            target2: getLanguageFor('target2'),
            target3: getLanguageFor('target3')
          },
          layoutClasses: {
            source: sourceClasses
          },
          styles: {
            source: getStyleFor('source'),
            target1: getStyleFor('target1'),
            target2: getStyleFor('target2'),
            target3: getStyleFor('target3')
          }
        }
      }
    }
  });
}

/** 認證完成後補送在連線建立前累積的字幕與自動設定要求。 */
function flushPendingPushes() {
  if (pendingSourcePush) pushSourceToObs();
  if (pendingTranslationPush) pushTranslationsToObs();
  
  if (pendingAutoSetup) {
      pendingAutoSetup = false;
      setTimeout(() => executeAutoSetup(), 500);
  }
}

/** 處理 op 0 Hello：依 OBS 是否要求認證，決定 Identify 要不要帶 token。 */
function handleHello(data) {
  const auth = data?.authentication;
  if (!auth) {
    setBridgeStatus('OBS Bridge: hello received, no auth required');
    sendIdentify('');
    return;
  }

  setBridgeStatus('OBS Bridge: hello received, authenticating...');
  buildAuthToken(getPassword(), auth.salt, auth.challenge)
    .then((token) => sendIdentify(token))
    .catch(() => {
      setBridgeStatus('OBS Bridge: auth token build failed');
      sendIdentify('');
    });
}

/**
 * 確保連線存在且連的是目前設定的位址。
 * 已經連上（或正在連）同一組位址與密碼時直接返回，因此可以放心地重複呼叫——
 * 每次發布字幕都會經過這裡，順便完成「尚未連線就自動連上」。
 */
function ensureConnection() {
  if (!isEnabled()) {
    disconnectObsBridge();
    return;
  }

  const url = getObsUrl();
  const password = getPassword();
  if (!url) return;

  if (socket && socket.readyState === WebSocket.OPEN && currentUrl === url && currentPassword === password) return;
  if (socket && socket.readyState === WebSocket.CONNECTING && currentUrl === url && currentPassword === password) return;

  safeCloseSocket();
  currentUrl = url;
  currentPassword = password;

  try {
    socket = new WebSocket(url);
  } catch (_) {
    setBridgeStatus('OBS Bridge: socket create failed');
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    clearReconnectTimer();
    setBridgeStatus(`OBS Bridge: connected to ${url}`);
  };

  socket.onmessage = (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    const op = message?.op;
    const data = message?.d || {};

    if (op === 0) {
      handleHello(data);
      return;
    }

    if (op === 2) {
      authenticated = true;
      setBridgeStatus('OBS Bridge: identified/authenticated');
      flushPendingPushes();
      return;
    }
  };

  socket.onerror = () => {
    setBridgeStatus('OBS Bridge: websocket error');
  };

  socket.onclose = (event) => {
    socket = null;
    authenticated = false;
    const closeCode = event?.code ?? 'unknown';
    const closeReason = event?.reason || '';
    setBridgeStatus(`OBS Bridge: disconnected code=${closeCode} ${closeReason}`.trim());
    if (isEnabled()) scheduleReconnect();
  };
}

/**
 * 發布辨識原文。未連線時會順帶建立連線，未認證時先緩衝。
 * @param {string} text
 */
export function publishSourceTextToObs(text) {
  latestSourceText = typeof text === 'string' ? text : '';
  ensureConnection();
  pushSourceToObs();
}

/**
 * 發布三組翻譯結果。不足三個會補空字串，overlay 端不必處理缺項。
 * @param {string[]} translations - [翻訳1, 翻訳2, 翻訳3]
 */
export function publishTranslationsToObs(translations) {
  latestTranslations = normalizeTranslations(translations);
  ensureConnection();
  pushTranslationsToObs();
}

/**
 * OBS 相關設定變更後重新對齊連線狀態：停用就斷線、位址或密碼變了就重連，
 * 兩者都沒變則只把最新字幕重送一次（例如剛切換了翻譯語言）。
 * 呼叫端已在 settingsBindings.js 做過節流，這裡不需要再防抖。
 */
export function handleObsBridgeSettingsChanged() {
  if (!isEnabled()) {
    setBridgeStatus('OBS Bridge: disabled');
    disconnectObsBridge();
    return;
  }

  const desiredUrl = getObsUrl();
  const desiredPassword = getPassword();

  if (!socket) {
    ensureConnection();
    return;
  }

  if (desiredUrl !== currentUrl || desiredPassword !== currentPassword) {
    safeCloseSocket();
    ensureConnection();
    return;
  }

  if (authenticated || pendingSourcePush || pendingTranslationPush) {
    pushSourceToObs();
    pushTranslationsToObs();
  }
}

/** 主動斷線並取消重連排程。停用整合或關閉頁面時呼叫。 */
export function disconnectObsBridge() {
  clearReconnectTimer();
  safeCloseSocket();
}

/**
 * 接続テスト：一時的な WebSocket で OBS WebSocket v5 のハンドシェイク
 * (Hello → Identify → Identified) まで到達できるかを検証する。
 * 主接続（socket）には一切影響しない。
 * @returns {Promise<boolean>} Identified まで到達できれば true
 */
export function testObsConnection() {
  return new Promise((resolve) => {
    const url = getObsUrl();
    const password = getPassword();
    let testSocket = null;
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (testSocket) {
        testSocket.onopen = testSocket.onmessage = testSocket.onerror = testSocket.onclose = null;
        try { testSocket.close(); } catch (_) { /* 已經關閉或關閉失敗都不影響測試結果。 */ }
      }
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), 6000);

    try {
      testSocket = new WebSocket(url);
    } catch (_) {
      finish(false);
      return;
    }

    testSocket.onmessage = async (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      const op = message?.op;
      if (op === 0) {
        const auth = message?.d?.authentication;
        let token = '';
        if (auth) {
          try { token = await buildAuthToken(password, auth.salt, auth.challenge); } catch (_) { /* 算不出 token 就送空的，讓 OBS 回應認證失敗即可。 */ }
        }
        const identify = { rpcVersion: 1, eventSubscriptions: 0 };
        if (token) identify.authentication = token;
        try { testSocket.send(JSON.stringify({ op: 1, d: identify })); } catch (_) { finish(false); }
      } else if (op === 2) {
        finish(true);
      }
    };

    testSocket.onerror = () => finish(false);
    testSocket.onclose = () => finish(false);
  });
}

window.addEventListener('beforeunload', () => {
  disconnectObsBridge();
});
