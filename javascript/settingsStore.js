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
 */

import { getSonioxEndpointDefaults } from './config.js';

const sonioxDefaults = getSonioxEndpointDefaults();

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
  const raw = localStorage.getItem(key);
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
  localStorage.setItem(key, String(value));
}

/**
 * 這個設定是否曾經被寫入過。
 * 用於區分「使用者選了與預設值相同的值」與「從未動過」，例如
 * ?debug=true 只有在使用者沒有自己設定過的情況下才該生效。
 */
export function hasStoredSetting(key) {
  return localStorage.getItem(key) !== null;
}
