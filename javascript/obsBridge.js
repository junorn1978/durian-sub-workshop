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

function generateObsOverlayUrl(fileName) {
  const baseUrl = window.location.href.split('?')[0].replace(/index\.html$/, '').replace(/\/$/, '');
  const url = getObsUrl();
  const pwd = getPassword();
  return `${baseUrl}/${fileName}#url=${encodeURIComponent(url)}&pwd=${encodeURIComponent(pwd)}`;
}

export function triggerAutoSetup() {
  if (!isEnabled()) {
    alert("請先啟用 OBS WebSocket Bridge 並連線");
    return;
  }
  if (!authenticated) {
    alert("OBS WebSocket 尚未連線成功，請確認 URL 與密碼，並等待連線完成。");
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
    if (!mainSceneName) throw new Error("無法取得目前場景名稱");

    console.log(`[OBS Bridge] Auto setup starting for main scene: ${mainSceneName}`);

    // 定義要建立的來源
    const sourcesToCreate = [
      { name: 'HamHam字幕-全顯示', file: 'obs_overlay.html', visible: true },
      { name: 'HamHam字幕-語音', file: 'obs_overlay_source.html', visible: false },
      { name: 'HamHam字幕-翻譯1', file: 'obs_overlay_target1.html', visible: false },
      { name: 'HamHam字幕-翻譯2', file: 'obs_overlay_target2.html', visible: false },
      { name: 'HamHam字幕-翻譯3', file: 'obs_overlay_target3.html', visible: false }
    ];

    const groupSceneName = '🌟 ハムハム字幕群組';

    // 1. 嘗試建立作為「群組」的新場景
    try {
      await sendSingleRequest('CreateScene', { sceneName: groupSceneName });
      console.log(`[OBS Bridge] Created group scene: ${groupSceneName}`);
    } catch (e) {
      console.log(`[OBS Bridge] Group scene might already exist: ${groupSceneName}`);
    }

    // 2. 將所有的 Browser Source 建立在「群組場景」裡面
    for (const source of sourcesToCreate) {
      try {
        const url = generateObsOverlayUrl(source.file);
        await sendSingleRequest('CreateInput', {
          sceneName: groupSceneName, // 直接建立在群組場景裡
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
        console.log(`[OBS Bridge] Created source in group: ${source.name}`);
      } catch (e) {
        console.warn(`[OBS Bridge] Failed to create source ${source.name}, attempting to update...`);
        try {
          await sendSingleRequest('SetInputSettings', {
            inputName: source.name,
            inputSettings: {
              url: generateObsOverlayUrl(source.file),
              width: 1280,
              height: 200,
              css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }'
            }
          });
          
          // 嘗試更新顯示狀態
          const idRes = await sendSingleRequest('GetSceneItemId', {
              sceneName: groupSceneName,
              sourceName: source.name
          });
          await sendSingleRequest('SetSceneItemEnabled', {
              sceneName: groupSceneName,
              sceneItemId: idRes.sceneItemId,
              sceneItemEnabled: source.visible
          });
        } catch(err2) {
          console.error(`[OBS Bridge] Cannot recover source ${source.name}:`, err2.message);
        }
      }
    }

    // 3. 把「群組場景」當作一個來源，加到「使用者目前的場景」中
    try {
       await sendSingleRequest('CreateSceneItem', {
          sceneName: mainSceneName,
          sourceName: groupSceneName
       });
       console.log(`[OBS Bridge] Added group scene to main scene.`);
    } catch(e) {
       console.log(`[OBS Bridge] Group scene is likely already in the main scene.`);
    }

    alert("OBS 字幕來源自動構建完成！\n已為您建立『🌟 ハムハム字幕群組』並加入到目前畫面中。\n預設僅開啟『全顯示』，您可以點進群組自由開關其他獨立來源。");

  } catch (error) {
    console.error("[OBS Bridge] Auto setup failed:", error);
    alert("OBS 自動構建失敗: " + error.message);
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
