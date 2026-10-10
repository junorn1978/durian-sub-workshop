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
 * 右邊的「タブの音声」按鈕開關分頁（或視窗）的共用（見 tabAudio.js）。共用中辨識聽分頁，
 * 麥克風選單停用。不放進清單裡：選了它就要立刻跳出列著所有分頁的對話框，跟「選一支
 * 麥克風」是不同性質的操作；做成按鈕，共用中也一眼看得出來。
 */

import { getSetting, setSetting } from './settingsStore.js';
import { createLogger } from './logger.js';
import { updateStatusDisplay } from './uiState.js';
import { openTabShare, closeTabShare, hasTabShare, getTabShareLabel, onTabShareChange, NoTabAudioError } from './tabAudio.js';

const log = createLogger('MicSelector');

const ID_KEY = 'mic-device-id';
const LABEL_KEY = 'mic-device-label';
const ALIASES = new Set(['default', 'communications']);

/** v3.1.37（未發布的分支）把分頁的聲音存成這個 id；載入時清掉。 */
const LEGACY_TAB_ID = 'tab';

let selectEl = null;
/** 目前清單上真實裝置的 id → 名稱（選項文字可能帶著「未接続」之類的標示，不能拿來存）。 */
let deviceLabels = new Map();
const listeners = new Set();

/** 選定的裝置 id。'' 表示系統既定。 */
export function getSelectedMicId() {
  return getSetting(ID_KEY) || '';
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

  // id 變了但名稱還在（清除過網站資料）：用名稱找回來。
  if (id && label && hasLabels && !devices.some(d => d.deviceId === id)) {
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
  const missing = !!id && hasLabels && !devices.some(d => d.deviceId === id);
  if (id && !devices.some(d => d.deviceId === id)) {
    opts.push(option(id, missing ? `⚠ 未接続：${label || 'マイク'}（既定を使用中）` : (label || 'マイク')));
  }

  selectEl.replaceChildren(...opts);
  selectEl.value = id;
  selectEl.classList.toggle('is-missing', missing);
  renderSelectState();
}

/** 共用中は選單を停用（聽的是分頁，選麥克風沒有作用）。說明放在 title。 */
function renderSelectState() {
  if (!selectEl) return;
  const sharing = hasTabShare();
  selectEl.disabled = sharing;
  const label = getSetting(LABEL_KEY) || '';
  selectEl.title = sharing
    ? 'タブの音声を聞いています。マイクに戻すには、右の「タブの音声」ボタンで共有を終了してください。'
    : selectEl.classList.contains('is-missing')
      ? `選択したマイク「${label}」が見つからないため、既定のマイクを使っています。`
      : (selectEl.selectedOptions[0]?.textContent || '');
}

/** 頁面載入時呼叫一次。 */
export function mountMicSelector() {
  selectEl = document.getElementById('mic-select');
  if (!selectEl) return;
  if (getSetting(ID_KEY) === LEGACY_TAB_ID) setSetting(ID_KEY, '');

  selectEl.addEventListener('change', () => {
    const value = selectEl.value;
    setSetting(ID_KEY, value);
    // 選回清單上的「未接続」項目時沒有新名稱，沿用原本存的。
    if (!value) setSetting(LABEL_KEY, '');
    else if (deviceLabels.get(value)) setSetting(LABEL_KEY, deviceLabels.get(value));
    log.info('マイクを変更:', selectEl.selectedOptions[0]?.textContent || value);
    refreshMicList();
    for (const fn of listeners) fn();
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshMicList());
  refreshMicList();
}

/* ============ タブの音声ボタン ============ */

let tabButton = null;

function renderTabButton() {
  if (!tabButton) return;
  const sharing = hasTabShare();
  tabButton.setAttribute('aria-pressed', String(sharing));
  tabButton.textContent = sharing ? 'タブの音声：共有中' : 'タブの音声';
  tabButton.title = sharing
    ? `「${getTabShareLabel() || 'タブ'}」の音声を聞いています。クリックで共有を終了します（認識中なら認識も停止します）。`
    : 'コラボ相手の声など、ブラウザのタブやアプリのウィンドウの音声を字幕にします。クリックすると、共有するタブを選ぶ画面が開きます。';
}

/** 共用開不了時，在狀態列說明原因。對話框按取消是使用者自己的決定，不說什麼。 */
function reportShareFailed(err) {
  if (err?.name === 'NotAllowedError') return;
  log.warn('タブを共有できませんでした:', err);
  updateStatusDisplay(err instanceof NoTabAudioError
    ? 'タブの音声が共有されていません。共有するときに「タブの音声も共有する」（ウィンドウなら「アプリの音声も共有する」）をオンにしてください。'
    : 'タブを共有できませんでした。もう一度「タブの音声」ボタンを押してください。');
}

/** 頁面載入時呼叫一次。瀏覽器不支援共用就不顯示按鈕。 */
export function mountTabShareButton() {
  tabButton = document.getElementById('tab-share-btn');
  if (!tabButton) return;
  if (!navigator.mediaDevices?.getDisplayMedia) { tabButton.hidden = true; return; }

  tabButton.addEventListener('click', async () => {
    if (hasTabShare()) { closeTabShare(); return; }
    tabButton.disabled = true;   // 對話框開著時不要再開一個
    try {
      await openTabShare();
    } catch (err) {
      reportShareFailed(err);
    } finally {
      tabButton.disabled = false;
    }
  });
  onTabShareChange(() => {
    renderTabButton();
    renderSelectState();
  });
  renderTabButton();
}
