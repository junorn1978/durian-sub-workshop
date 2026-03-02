/**
 * @file obsBridge.js
 * @description Direct OBS WebSocket bridge (obs-websocket v5).
 */

const OBS_ENABLED_KEY = 'obs-ws-enabled';
const OBS_URL_KEY = 'obs-ws-url';
const OBS_PASSWORD_KEY = 'obs-ws-password';
const OBS_SEND_SOURCE_KEY = 'obs-send-source';
const OBS_SEND_TRANSLATION_KEY = 'obs-send-translation';
const OBS_INPUT_SOURCE_KEY = 'obs-input-source';
const OBS_INPUT_TARGET1_KEY = 'obs-input-target1';
const OBS_INPUT_TARGET2_KEY = 'obs-input-target2';
const OBS_INPUT_TARGET3_KEY = 'obs-input-target3';

const DEFAULT_OBS_WS_URL = 'ws://127.0.0.1:4455';
const DEFAULT_INPUT_SOURCE = 'Hamu_Source';
const DEFAULT_INPUT_TARGET1 = 'Hamu_Target1';
const DEFAULT_INPUT_TARGET2 = 'Hamu_Target2';
const DEFAULT_INPUT_TARGET3 = 'Hamu_Target3';
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

function shouldSendSource() {
  const value = localStorage.getItem(OBS_SEND_SOURCE_KEY);
  return value === null ? true : value === 'true';
}

function shouldSendTranslation() {
  const value = localStorage.getItem(OBS_SEND_TRANSLATION_KEY);
  return value === null ? true : value === 'true';
}

function getObsUrl() {
  const value = (localStorage.getItem(OBS_URL_KEY) || '').trim();
  return value || DEFAULT_OBS_WS_URL;
}

function getPassword() {
  return (localStorage.getItem(OBS_PASSWORD_KEY) || '').trim();
}

function getInputNames() {
  return {
    source: (localStorage.getItem(OBS_INPUT_SOURCE_KEY) || '').trim() || DEFAULT_INPUT_SOURCE,
    target1: (localStorage.getItem(OBS_INPUT_TARGET1_KEY) || '').trim() || DEFAULT_INPUT_TARGET1,
    target2: (localStorage.getItem(OBS_INPUT_TARGET2_KEY) || '').trim() || DEFAULT_INPUT_TARGET2,
    target3: (localStorage.getItem(OBS_INPUT_TARGET3_KEY) || '').trim() || DEFAULT_INPUT_TARGET3
  };
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

function sendSetInputText(inputName, textValue, kind) {
  if (!authenticated || !inputName) return;
  requestCounter += 1;
  const typeTag = kind || 'src';
  sendRaw({
    op: 6,
    d: {
      requestType: 'SetInputSettings',
      requestId: `hamu-${typeTag}-${requestCounter}`,
      requestData: {
        inputName,
        inputSettings: {
          text: textValue
        },
        overlay: true
      }
    }
  });
}

function handleRequestResponse(data) {
  const requestType = data?.requestType || '';
  if (requestType !== 'SetInputSettings') return;
  const requestId = data?.requestId || '';
  if (!requestId.includes('tr-')) return;

  const requestStatus = data?.requestStatus || {};
  if (requestStatus?.result) return;

  const code = requestStatus?.code ?? 'unknown';
  const comment = requestStatus?.comment || '';
  setBridgeStatus(`OBS Bridge error: request=${requestId} code=${code} ${comment}`.trim());
}

function pushSourceToObs() {
  if (!authenticated) {
    pendingSourcePush = true;
    return;
  }
  pendingSourcePush = false;
  if (!shouldSendSource()) return;
  const inputNames = getInputNames();
  sendSetInputText(inputNames.source, latestSourceText, 'src');
}

function pushTranslationsToObs() {
  if (!authenticated) {
    pendingTranslationPush = true;
    return;
  }
  pendingTranslationPush = false;
  if (!shouldSendTranslation()) return;
  const inputNames = getInputNames();
  sendSetInputText(inputNames.target1, latestTranslations[0] || '', 'tr-1');
  sendSetInputText(inputNames.target2, latestTranslations[1] || '', 'tr-2');
  sendSetInputText(inputNames.target3, latestTranslations[2] || '', 'tr-3');
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

    if (op === 7) {
      handleRequestResponse(data);
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
