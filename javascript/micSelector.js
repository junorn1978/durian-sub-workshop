/**
 * @file micSelector.js
 * @description 左下狀態列的麥克風選擇（「マイク選択」＋膠囊形的 select）。
 *
 * 選擇存成 mic-device-id（＋它的名稱 mic-device-label），Web Speech 與 Soniox 都從
 * getSelectedMicId() 拿裝置。辨識中換裝置會立刻切換（見 onMicChange 的訂閱端）。
 *
 * 不在載入時開麥克風。以前為了顯示一個名稱，頁面一打開就 getUserMedia 一次；
 * 權限給過的話，enumerateDevices 不開麥克風也拿得到名稱，沒給過就等開始之後再補上。
 *
 * 清單的做法沿用 即時翻譯 的 ui-mic.js：
 *   - 'default' / 'communications' 是「Windows 說的那支」的別名，跟「既定」重複，不列。
 *   - 選定的裝置拔掉時仍留在清單上（標示未接続），插回去就接上；這段期間辨識用既定裝置。
 *   - deviceId 是每個網站各自的，清除網站資料就會換掉；名稱不會，所以先用名稱找回來。
 *
 * 清單最後、分隔線下面是「タブの音声」（TAB_AUDIO）：不是裝置，是共用分頁或視窗的聲音
 * （見 tabAudio.js）。
 */

import { getSetting, setSetting } from './settingsStore.js';
import { createLogger } from './logger.js';

const log = createLogger('MicSelector');

const ID_KEY = 'mic-device-id';
const LABEL_KEY = 'mic-device-label';
const ALIASES = new Set(['default', 'communications']);

/** 代表「分頁（或視窗）的聲音」而不是麥克風的 id。 */
export const TAB_AUDIO = 'tab';

let selectEl = null;
/** 目前清單上真實裝置的 id → 名稱（選項文字可能帶著「未接続」之類的標示，不能拿來存）。 */
let deviceLabels = new Map();
const listeners = new Set();

/** 選定的裝置 id。'' 表示系統既定。 */
export function getSelectedMicId() {
  return getSetting(ID_KEY) || '';
}

/** 選的是分頁的聲音嗎。 */
export function isTabAudioSelected() {
  return getSelectedMicId() === TAB_AUDIO;
}

/** 選擇變更時呼叫 fn()。回傳取消訂閱的函式。 */
export function onMicChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

/* Windows 的 Chrome / Edge 會把既定裝置列成「既定 - 名稱」／「Default - 名稱」。 */
function stripDefaultPrefix(label) {
  return label.replace(/^(既定|デフォルト|Default)\s*-\s*/i, '');
}

/**
 * 重建清單。裝置插拔、取得麥克風權限之後（名稱才會出現）都要呼叫。
 */
export async function refreshMicList() {
  if (!selectEl || !navigator.mediaDevices?.enumerateDevices) return;

  let all = [];
  try {
    all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  } catch (err) {
    log.warn('裝置清單取得失敗:', err);
  }
  const devices = all.filter(d => d.deviceId && !ALIASES.has(d.deviceId));
  const hasLabels = devices.some(d => d.label);
  deviceLabels = new Map(devices.map(d => [d.deviceId, d.label]));

  const id = getSelectedMicId();
  const label = getSetting(LABEL_KEY) || '';
  const isTab = id === TAB_AUDIO;

  // id 變了但名稱還在（清除過網站資料）：用名稱找回來。
  if (id && !isTab && label && hasLabels && !devices.some(d => d.deviceId === id)) {
    const same = devices.find(d => d.label === label);
    if (same) {
      setSetting(ID_KEY, same.deviceId);
      return refreshMicList();
    }
  }

  const defaultEntry = all.find(d => d.deviceId === 'default');
  const defaultName = defaultEntry?.label ? stripDefaultPrefix(defaultEntry.label) : '';
  const opts = [option('', defaultName ? `既定（${defaultName}）` : '既定のマイク')];
  for (const d of devices) opts.push(option(d.deviceId, d.label || '名前を取得できないマイク'));

  // 權限還沒給過時沒有 id 可比，不能說它不見了。
  const missing = !!id && !isTab && hasLabels && !devices.some(d => d.deviceId === id);
  if (id && !isTab && !devices.some(d => d.deviceId === id)) {
    opts.push(option(id, missing ? `⚠ 未接続：${label || 'マイク'}（既定を使用中）` : (label || 'マイク')));
  }
  // 不是裝置：放在分隔線下面、最後，讓麥克風看起來是同一組。
  if (navigator.mediaDevices.getDisplayMedia) {
    opts.push(document.createElement('hr'), option(TAB_AUDIO, 'タブ・ウィンドウの音声'));
  }

  selectEl.replaceChildren(...opts);
  selectEl.value = id;
  selectEl.classList.toggle('is-missing', missing);
  selectEl.title = missing
    ? `選択したマイク「${label}」が見つからないため、既定のマイクを使っています。`
    : (selectEl.selectedOptions[0]?.textContent || '');
}

/** 頁面載入時呼叫一次。 */
export function mountMicSelector() {
  selectEl = document.getElementById('mic-select');
  if (!selectEl) return;

  selectEl.addEventListener('change', () => {
    const value = selectEl.value;
    setSetting(ID_KEY, value);
    // 選回清單上的「未接続」項目時沒有新名稱，沿用原本存的。
    if (!value || value === TAB_AUDIO) setSetting(LABEL_KEY, '');
    else if (deviceLabels.get(value)) setSetting(LABEL_KEY, deviceLabels.get(value));
    log.info('マイクを変更:', selectEl.selectedOptions[0]?.textContent || value);
    refreshMicList();
    for (const fn of listeners) fn();
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshMicList());
  refreshMicList();
}
