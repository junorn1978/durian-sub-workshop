/**
 * @file settingsStore.js
 * @description 設定值的單一來源。所有 localStorage 的設定讀取都應該經過這裡。
 *
 * 以前預設值散在兩個地方：uiController.js 的 CONFIG 有一份給 UI 用，
 * 各個消費端（speechCapture、obsBridge…）自己再寫一份給邏輯用。
 * 問題在於 UI 的 select 只是把預設值顯示出來，並不會寫進 localStorage，
 * 所以「使用者從沒動過這個選項」時，消費端拿到的是 null 而不是預設值——
 * v3.1.18 的「字幕の自動クリアが既定値のままだと動かない」就是這樣來的
 * （Number(null) 是 0，剛好等於「不清除」）。
 *
 * 這裡刻意不做 write-through（載入時把預設值補寫回 localStorage）。
 * 那樣雖然能讓消費端繼續用 getItem，但等於把預設值凍結在使用者的瀏覽器裡，
 * 日後調整預設值就再也推不到既有使用者身上。改成讀取時才套用預設值。
 *
 * 【第二個視窗（index.html?ch=2）】
 * 連動時用來聽另一個音源（對方的 Discord 等），與第一個視窗各自辨識。
 * localStorage 是同一個網站的所有視窗共用的，所以「這一路的設定」（聲音來源、語言、
 * 辨識引擎與斷句、字幕外觀）在第二個視窗存成 'ch2:' 開頭的 key；OBS 連線、翻譯服務
 * 這類兩邊一樣的設定照舊共用。第二個視窗第一次打開時，複製一份第一個視窗當時的值
 * （麥克風除外），之後各自獨立，改其中一邊不會影響另一邊。
 */

import { getSonioxEndpointDefaults } from './config.js';

const sonioxDefaults = getSonioxEndpointDefaults();

/** 這個視窗是第幾路（1 或 2）。只支援兩個，太多使用者不好管理。
 *  index.html 的 <head> 也看同一個 ?ch=2 來先換配色和標題（那裡不能用 module）。 */
export const CHANNEL = new URLSearchParams(location.search).get('ch') === '2' ? 2 : 1;

const CH2_PREFIX = 'ch2:';
const CH2_INITIALIZED_KEY = 'ch2:initialized';

/* 每個視窗各自一份的設定。字型樣式（source/target1~3 的顏色・大小・外框）用規則比對。 */
const PER_CHANNEL_KEYS = new Set([
  'mic-device-id', 'mic-device-label',
  'source-language', 'target1-language', 'target2-language', 'target3-language',
  'speech-recognition-engine',
  'soniox-latency-level', 'soniox-sensitivity', 'soniox-max-delay-ms',
  'subtitle-clear-idle-sec',
  'text-alignment', 'force-single-line-enabled', 'display-panel-color'
]);
const PER_CHANNEL_STYLE = /^(source|target[123])-font-(color|stroke-color|size|stroke-size)$/;

/* 第二個視窗第一次打開時不複製的設定：裝置的選擇沒有理由沿用。 */
const NOT_COPIED = new Set(['mic-device-id', 'mic-device-label']);

function isPerChannel(key) {
  return PER_CHANNEL_KEYS.has(key) || PER_CHANNEL_STYLE.test(key);
}

/** 實際存在 localStorage 裡的 key。 */
function storageKey(key) {
  return CHANNEL === 2 && isPerChannel(key) ? CH2_PREFIX + key : key;
}

/* 第二個視窗第一次打開：複製第一個視窗當時的值。 */
if (CHANNEL === 2 && localStorage.getItem(CH2_INITIALIZED_KEY) === null) {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key.startsWith(CH2_PREFIX) || !isPerChannel(key) || NOT_COPIED.has(key)) continue;
    localStorage.setItem(CH2_PREFIX + key, localStorage.getItem(key));
  }
  localStorage.setItem(CH2_INITIALIZED_KEY, 'true');
}

/**
 * 設定 key 與其預設值。值一律以字串保存，與 localStorage 的型別一致。
 * 字型顏色、大小之類的樣式設定不在此列——它們的預設值來自 CSS 自訂屬性。
 * @type {Readonly<Record<string, string>>}
 */
export const SETTING_DEFAULTS = Object.freeze({
  // OBS 連動
  'obs-ws-enabled': 'false',
  'obs-ws-ip': '127.0.0.1',
  'obs-ws-port': '4455',
  'obs-ws-password': '',

  // 音声認識
  'speech-recognition-engine': 'soniox',
  'soniox-latency-level': String(sonioxDefaults.latencyLevel),
  'soniox-sensitivity': String(sonioxDefaults.sensitivity),
  'soniox-max-delay-ms': String(sonioxDefaults.maxDelayMs),
  'auto-stop-enabled': 'true',
  'pause-duration-min': '3',
  'subtitle-clear-idle-sec': '7',
  'mic-device-id': '',          // '' = 系統既定（見 micSelector.js）
  'mic-device-label': '',

  // 表示・システム
  'text-alignment': 'center',
  'click-minimize-enabled': 'true',
  'force-single-line-enabled': 'true',
  'log-system-debug-enabled': 'false',

  // 翻訳
  'translation-mode-selection': 'gtx',
  'translation-link': ''
});

/**
 * 讀取設定值。未設定或為空字串時回傳預設值。
 * @param {string} key
 * @param {string|null} [fallback] - 不在 SETTING_DEFAULTS 內的 key（例如樣式設定）所使用的後備值
 * @returns {string|null}
 */
export function getSetting(key, fallback = null) {
  const raw = localStorage.getItem(storageKey(key));
  if (raw !== null && raw !== '') return raw;
  const preset = SETTING_DEFAULTS[key];
  return preset !== undefined ? preset : fallback;
}

/** 讀取布林設定。字串 'true' 以外一律視為 false。 */
export function getSettingBool(key) {
  return getSetting(key) === 'true';
}

/**
 * 讀取數值設定。無法解析、或不在允許範圍內時回傳預設值。
 * @param {string} key
 * @param {{ min?: number, max?: number, allowed?: number[] }} [options]
 */
export function getSettingNumber(key, { min = -Infinity, max = Infinity, allowed = null } = {}) {
  const fallback = Number(SETTING_DEFAULTS[key]);
  const value = Number(getSetting(key));
  if (!Number.isFinite(value)) return fallback;
  if (allowed && !allowed.includes(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 寫入設定值。 */
export function setSetting(key, value) {
  localStorage.setItem(storageKey(key), String(value));
}

/**
 * 這個設定是否曾經被寫入過。
 * 用於區分「使用者選了與預設值相同的值」與「從未動過」，例如
 * ?debug=true 只有在使用者沒有自己設定過的情況下才該生效。
 */
export function hasStoredSetting(key) {
  return localStorage.getItem(storageKey(key)) !== null;
}
