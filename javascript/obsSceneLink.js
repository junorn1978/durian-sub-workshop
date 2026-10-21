/**
 * @file obsSceneLink.js
 * @description シーン連動：OBS 切換場景時自動開始／停止辨識。與一時停止二選一。
 *
 * 【規則】在 OBS連携 的視窗裡，替每個場景選「何もしない／開始／停止」，存成
 * { 場景名稱: 'start' | 'stop' }。切到「開始」的場景就開始、切到「停止」的場景就停止，
 * 「何もしない」的場景維持原狀（例如從遊戲畫面切到聊天畫面，辨識照舊）。
 * 看的是節目（Program）場景，工作室模式下只切預覽不會觸發。
 *
 * 【為什麼和一時停止二選一】暫停有自己的自動恢復計時，場景也會叫它開始或停止，
 * 兩邊同時作用時「現在該不該在聽」就說不清楚。開啟シーン連動時，標誌的一時停止不能按。
 *
 * 剛連上 OBS 時不看目前的場景，只有「切換」才會動作，避免一打開頁面就開始收音。
 * 場景在 OBS 裡改名時，規則跟著改名。已經不存在的場景的規則留著不刪
 * （OBS 暫時關掉或換了場景集合時，清單是空的，不該把設定洗掉）。
 *
 * 規則與開關是每個視窗各自一份（見 settingsStore.js 的 PER_CHANNEL_KEYS）。
 *
 * 【兩個視窗分工】設定畫面在另開的 OBS連携 視窗（obs_settings.html），不在主視窗裡：
 * 主視窗常被 OBS 的ウィンドウキャプチャ拍進直播，場景名稱不一定能給人看。
 *   - 主視窗：mountObsSceneLink()——收場景切換、開始／停止、場景改名時搬規則。
 *   - 設定視窗：mountSceneRuleList()——畫場景清單、存規則。
 * 兩邊只透過 localStorage 交換：主視窗每次切場景都重讀規則，所以不必通知；
 * 開關則由 settingsBindings.js 監聽 storage 事件，再呼叫 applySceneLinkEnabled()。
 */

import {
  onProgramSceneChanged, onSceneListChanged, onSceneRenamed, fetchSceneNames, isObsConnected
} from './obsBridge.js';
import { getSetting, getSettingBool, setSetting, onExternalSettingChange } from './settingsStore.js';
import { setPauseAvailable } from './uiState.js';
import { createLogger } from './logger.js';

const log = createLogger('ObsSceneLink');

const ENABLED_KEY = 'obs-scene-link-enabled';
const RULES_KEY = 'obs-scene-rules';

const ACTION_LABELS = { '': '何もしない', start: '開始', stop: '停止' };

/** @type {(action: 'start'|'stop', sceneName: string) => void} */
let applyAction = () => {};

function isEnabled() {
  return getSettingBool(ENABLED_KEY);
}

/** @returns {Record<string, 'start'|'stop'>} */
function loadRules() {
  try {
    const rules = JSON.parse(getSetting(RULES_KEY));
    return rules && typeof rules === 'object' ? rules : {};
  } catch {
    return {};
  }
}

function saveRules(rules) {
  setSetting(RULES_KEY, JSON.stringify(rules));
}

function setListStatus(text) {
  const status = document.getElementById('obs-scene-status');
  if (status) status.textContent = text;
}

function buildSceneRow(sceneName, action) {
  const row = document.createElement('div');
  row.className = 'settings-row obs-scene-row';
  row.dataset.action = action;

  const label = document.createElement('span');
  label.className = 'settings-row-label obs-scene-name';
  label.textContent = sceneName;
  label.title = sceneName;

  const select = document.createElement('select');
  select.className = 'card-select';
  for (const [value, text] of Object.entries(ACTION_LABELS)) {
    select.add(new Option(text, value, false, value === action));
  }
  select.addEventListener('change', () => {
    const rules = loadRules();
    if (select.value) rules[sceneName] = select.value;
    else delete rules[sceneName];
    saveRules(rules);
    row.dataset.action = select.value;
  });

  row.append(label, select);
  return row;
}

/** 向 OBS 抓場景清單並重畫（設定視窗）。シーン連動 關閉時不抓。 */
async function refreshSceneList() {
  const list = document.getElementById('obs-scene-list');
  if (!list || !isEnabled()) return;

  if (!isObsConnected()) {
    list.replaceChildren();
    setListStatus('OBS に接続されていません（「OBS WebSocket」を有効にして、接続を確認してください）');
    return;
  }

  let names;
  try {
    names = await fetchSceneNames();
  } catch (error) {
    log.error('シーン一覧を取得できませんでした:', error.message);
    setListStatus('シーン一覧を取得できませんでした');
    return;
  }

  const rules = loadRules();
  list.replaceChildren(...names.map(name => buildSceneRow(name, rules[name] || '')));
  setListStatus(names.length ? '切り替えたときの動作をシーンごとに選んでください' : 'シーンがありません');
}

function handleProgramSceneChanged(sceneName) {
  if (!isEnabled() || !sceneName) return;
  const action = loadRules()[sceneName];
  log.debug(`シーン切替: ${sceneName} → ${action || '何もしない'}`);
  if (action === 'start' || action === 'stop') applyAction(action, sceneName);
}

function handleSceneRenamed(oldName, newName) {
  const rules = loadRules();
  if (!oldName || !newName || !(oldName in rules)) return;
  rules[newName] = rules[oldName];
  delete rules[oldName];
  saveRules(rules);
}

/**
 * 主視窗：開關切換時（含頁面載入、設定視窗改了開關）由 settingsBindings.js 呼叫。
 * 開啟時一時停止不能按。
 * @param {boolean} enabled
 */
export function applySceneLinkEnabled(enabled) {
  setPauseAvailable(!enabled);
}

/**
 * 主視窗：收 OBS 的場景切換。
 * @param {{ onAction: (action: 'start'|'stop', sceneName: string) => void }} options
 *   場景要求開始／停止時的處理（speechCapture.js 提供）
 */
export function mountObsSceneLink({ onAction }) {
  applyAction = onAction;
  onProgramSceneChanged(handleProgramSceneChanged);
  onSceneRenamed(handleSceneRenamed);
}

/** 設定視窗：開關切換時顯示／隱藏場景清單。關閉時改顯示這個功能的說明。 */
export function showSceneRuleList(enabled) {
  const body = document.getElementById('obs-scene-link-body');
  if (body) body.hidden = !enabled;
  const note = document.getElementById('obs-scene-link-note');
  if (note) note.hidden = enabled;
  if (enabled) refreshSceneList();
}

/**
 * 設定視窗：場景清單。連上 OBS、場景增減改名時自動重畫，「一覧を更新」手動重畫。
 * 主視窗搬動規則（場景改名）時也重畫，清單上的選擇才不會停在舊名字上。
 */
export function mountSceneRuleList() {
  onSceneListChanged(refreshSceneList);
  onExternalSettingChange([RULES_KEY], refreshSceneList);
  document.getElementById('obs-scene-refresh-btn')?.addEventListener('click', refreshSceneList);
}
