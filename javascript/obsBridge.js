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
