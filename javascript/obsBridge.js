/**
 * @file obsBridge.js
 * @description Direct OBS WebSocket bridge (obs-websocket v5) - Broadcast Only.
 */

const OBS_ENABLED_KEY = 'obs-ws-enabled';
const OBS_URL_KEY = 'obs-ws-url';
const OBS_PASSWORD_KEY = 'obs-ws-password';

const DEFAULT_OBS_WS_URL = 'ws://127.0.0.1:4455';
const RECONNECT_DELAY_MS = 2000;

let socket = null;
let reconnectTimer = null;
let currentUrl = '';
let currentPassword = '';
let authenticated = false;
let requestCounter = 0;

let latestSourceText = '';
let latestTranslations = ['', '', ''];
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

export function triggerAutoSetup() {
  if (!isEnabled()) {
    alert("先に OBS WebSocket Bridge を有効にして接続してください。");
    return;
  }
  if (!authenticated) {
    alert("OBS WebSocket にまだ接続されていません。URLとパスワードを確認し、接続が完了するまでお待ちください。");
    pendingAutoSetup = true;
    ensureConnection();
    return;
  }
  executeAutoSetup();
}

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
      } catch (e) {}
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

async function executeAutoSetup() {
  try {
    const currentSceneResponse = await sendSingleRequest('GetCurrentProgramScene');
    const mainSceneName = currentSceneResponse.currentProgramSceneName || currentSceneResponse.sceneName || currentSceneResponse.sceneUuid;
    if (!mainSceneName) throw new Error("現在のシーン名を取得できませんでした");

    console.log(`[OBS Bridge] Auto setup starting for main scene: ${mainSceneName}`);

    // 定義要建立的來源
    const sourcesToCreate = [
      { name: 'HamHam字幕-全顯示', mode: 'all', visible: true },
      { name: 'HamHam字幕-語音', mode: 'source', visible: false },
      { name: 'HamHam字幕-翻譯1', mode: 'target1', visible: false },
      { name: 'HamHam字幕-翻譯2', mode: 'target2', visible: false },
      { name: 'HamHam字幕-翻譯3', mode: 'target3', visible: false }
    ];

    // 直接將所有的 Browser Source 建立在「使用者目前的場景」裡面
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
        console.log(`[OBS Bridge] Created source in main scene: ${source.name}`);
      } catch (e) {
        console.warn(`[OBS Bridge] Failed to create source ${source.name}. It likely already exists globally in OBS. Reason:`, e.message);
        
        try {
          // 既然來源已經存在於 OBS 中，我們需要確保它有被加進「當前場景」
          try {
             await sendSingleRequest('CreateSceneItem', {
                sceneName: mainSceneName,
                sourceName: source.name
             });
             console.log(`[OBS Bridge] Added existing source ${source.name} to the current scene.`);
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
          
          // 嘗試更新顯示狀態
          const idRes = await sendSingleRequest('GetSceneItemId', {
              sceneName: mainSceneName,
              sourceName: source.name
          });
          
          await sendSingleRequest('SetSceneItemEnabled', {
              sceneName: mainSceneName,
              sceneItemId: idRes.sceneItemId,
              sceneItemEnabled: source.visible
          });
          console.log(`[OBS Bridge] Successfully updated existing source: ${source.name}`);
        } catch(err2) {
          console.error(`[OBS Bridge] Cannot recover source ${source.name}:`, err2.message);
        }
      }
    }

    alert("OBS 字幕ソースの自動構築が完了しました！\n現在のシーンに5つの独立した字幕ソースを作成しました。\nデフォルトでは『全顯示(全体)』のみが表示されています。自由に配置やグループ化を行ってください。");

  } catch (error) {
    console.error("[OBS Bridge] Auto setup failed:", error);
    alert("OBS 自動構築に失敗しました: " + error.message);
  }
}

// ------------------------------


function isEnabled() {
  return localStorage.getItem(OBS_ENABLED_KEY) === 'true';
}

function getObsUrl() {
  const value = (localStorage.getItem(OBS_URL_KEY) || '').trim();
  return value || DEFAULT_OBS_WS_URL;
}

function getPassword() {
  return (localStorage.getItem(OBS_PASSWORD_KEY) || '').trim();
}

function normalizeTranslations(translations) {
  const arr = Array.isArray(translations) ? translations : [];
  return [arr[0] || '', arr[1] || '', arr[2] || ''];
}

function setBridgeStatus(text) {
  if (!text || text === lastStatusText) return;
  lastStatusText = text;
  const lowered = text.toLowerCase();
  const isError =
    lowered.includes('error') ||
    lowered.includes('failed') ||
    lowered.includes('disconnected') ||
    lowered.includes('code=4');
  if (isError) {
    console.error(`[OBS Bridge] ${text}`);
  }
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
    // no-op
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
    // no-op
  }
}

function sendIdentify(authentication = '') {
  const identifyData = {
    rpcVersion: 1,
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
  const target1El = document.getElementById('target-text-1');

  const sourceClasses = sourceEl ? Array.from(sourceEl.classList).filter(c => c.startsWith('visual-') || c.startsWith('overflow-')) : [];
  const targetClasses = target1El ? Array.from(target1El.classList).filter(c => c.startsWith('overflow-')) : [];

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
          layoutClasses: {
            source: sourceClasses,
            targets: targetClasses
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

function flushPendingPushes() {
  if (pendingSourcePush) pushSourceToObs();
  if (pendingTranslationPush) pushTranslationsToObs();
  
  if (pendingAutoSetup) {
      pendingAutoSetup = false;
      setTimeout(() => executeAutoSetup(), 500);
  }
}

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

export function publishSourceTextToObs(text) {
  latestSourceText = typeof text === 'string' ? text : '';
  ensureConnection();
  pushSourceToObs();
}

export function publishTranslationsToObs(translations) {
  latestTranslations = normalizeTranslations(translations);
  ensureConnection();
  pushTranslationsToObs();
}

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

export function disconnectObsBridge() {
  clearReconnectTimer();
  safeCloseSocket();
}

window.addEventListener('beforeunload', () => {
  disconnectObsBridge();
});
