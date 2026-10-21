/**
 * @file obsSettingsWindow.js
 * @description OBS連携 的設定視窗（obs_settings.html）。主視窗「OBS連携」按鈕另開。
 *
 * 【為什麼另開視窗】以前是主視窗裡的對話框，但主視窗常被 OBS 的ウィンドウキャプチャ
 * 拍進直播，打開設定就會連場景名稱一起播出去。另一個視窗不在擷取範圍內。
 *
 * 【和主視窗怎麼溝通】只靠 localStorage：這裡把值寫進去，主視窗收到 storage 事件後
 * 重新連線、切換一時停止能不能按（見 settingsBindings.js 的 bindObsWindowSettings）。
 * 場景規則主視窗每次切場景時才讀，所以不用通知。
 *
 * 這個視窗自己也連一條 OBS WebSocket（抓場景清單、加字幕來源），但不送字幕：
 * 它手上沒有字幕，送出去會把畫面上的字幕清掉。所以只用 connectObsBridge()，
 * 不用主視窗那個會順便重送字幕的 handleObsBridgeSettingsChanged()。
 */

import { getSetting, setSetting } from './settingsStore.js';
import {
  connectObsBridge, testObsConnection, triggerAutoSetup, refreshObsDragLinks, isObsConnected, onObsConnectionChange
} from './obsBridge.js';
import { mountSceneRuleList, showSceneRuleList } from './obsSceneLink.js';
import { setupModal } from './modals.js';
import { setupToggleVisibility } from './visibilityToggle.js';

/** IP／連接埠／密碼每打一個字都會寫入，重連等輸入停下來再做。 */
const RECONNECT_DEBOUNCE_MS = 300;

/* 欄位 id → 設定 key。select 以 change、文字欄位以 input 寫入。 */
const CONNECTION_FIELDS = [
  { id: 'obs-ws-enabled', key: 'obs-ws-enabled' },
  { id: 'obs-ws-ip', key: 'obs-ws-ip' },
  { id: 'obs-ws-port', key: 'obs-ws-port' },
  { id: 'obs-ws-password', key: 'obs-ws-password' }
];
const SCENE_LINK_FIELD = { id: 'obs-scene-link-opt', key: 'obs-scene-link-enabled' };

let reconnectTimer = null;

function applyConnection() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectObsBridge();
    refreshObsDragLinks();
  }, RECONNECT_DEBOUNCE_MS);
}

/** 把欄位接到設定上：載入目前的值，改了就寫回去並呼叫 onChange。 */
function bindField({ id, key }, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = getSetting(key) ?? '';
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    setSetting(key, el.value);
    onChange(el.value);
  });
}

/** 標題旁的連線狀態。無効／接続中／未接続（重連中）三種。 */
function renderConnectionBadge() {
  const badge = document.getElementById('obs-conn-badge');
  if (!badge) return;
  const state = getSetting('obs-ws-enabled') !== 'true' ? 'off' : isObsConnected() ? 'on' : 'retry';
  badge.dataset.state = state;
  badge.textContent = { off: '無効', on: '接続中', retry: '未接続' }[state];
  badge.title = {
    off: '「OBS WebSocket」が無効です',
    on: 'OBS に接続しています',
    retry: 'OBS に接続できていません。OBS が起動しているか、IP・ポート・パスワードを確認してください（自動で再接続します）'
  }[state];
}

function setupConnectionTest() {
  const testBtn = document.getElementById('obs-test-btn');
  const testStatus = document.getElementById('obs-test-status');

  testBtn?.addEventListener('click', async () => {
    if (testStatus) {
      testStatus.textContent = '接続中…';
      testStatus.className = 'obs-test-status testing';
    }
    testBtn.disabled = true;
    const ok = await testObsConnection();
    testBtn.disabled = false;
    if (testStatus) {
      testStatus.textContent = ok ? '接続成功' : '接続失敗';
      testStatus.className = `obs-test-status ${ok ? 'ok' : 'fail'}`;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  CONNECTION_FIELDS.forEach(field => bindField(field, () => { applyConnection(); renderConnectionBadge(); }));
  bindField(SCENE_LINK_FIELD, (value) => showSceneRuleList(value === 'true'));

  setupToggleVisibility('toggle-obs-pwd-visibility', 'obs-ws-password');
  setupModal({ overlayId: 'obs-help-modal-overlay', openButtonId: 'obs-help-btn', closeButtonId: 'obs-help-close' });
  setupConnectionTest();
  document.getElementById('obs-auto-setup-btn')?.addEventListener('click', () => triggerAutoSetup());
  document.getElementById('obs-window-close')?.addEventListener('click', () => window.close());

  onObsConnectionChange(renderConnectionBadge);
  renderConnectionBadge();
  mountSceneRuleList();
  showSceneRuleList(getSetting(SCENE_LINK_FIELD.key) === 'true');
  connectObsBridge();
  refreshObsDragLinks();
});
