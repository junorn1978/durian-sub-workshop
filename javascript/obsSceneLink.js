/**
 * @file obsSceneLink.js
 * @description シーン連動：OBS 切換場景時自動開始／停止辨識。與一時停止二選一。
 *
 * 【規則】在 OBS連携 的視窗裡，替每個場景選「開始／停止／何もしない」，預設是「開始」。
 * 只存不是預設的場景：{ 場景名稱: 'stop' | 'none' }，沒有記錄的場景就是「開始」
 * （新增的場景也是）。切到「開始」的場景就開始、切到「停止」的場景就停止，
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
 * 規則與開關兩個視窗共用一份：連動時切到休息畫面，對方的字幕（第二個視窗）也一起停。
 * 只能在第一個視窗的 OBS連携 改，第二個視窗的只顯示（見 obsSettingsWindow.js）。
 *
 * 【字幕の配色】每個場景也能換字幕的配色（subtitlePresets.js）：聊天畫面用可愛的、
 * 遊戲畫面用高對比的。這是另一條獨立的規則，「何もしない」的場景也能換色。
 * 沒指定的場景是「テーマそのまま」，所以手動挑的顏色不會被連動蓋掉，除非那個場景有指定。
 * 字幕外觀每個視窗各自一份，所以配色規則也是各自一份（'ch2:obs-scene-presets'），
 * 第二個視窗的 OBS連携 也能改這一欄。切場景時先換色再開始／停止。
 *
 * 【兩個視窗分工】設定畫面在另開的 OBS連携 視窗（obs_settings.html），不在主視窗裡：
 * 主視窗常被 OBS 的ウィンドウキャプチャ拍進直播，場景名稱不一定能給人看。
 *   - 主視窗：mountObsSceneLink()——收場景切換、開始／停止、場景改名時搬規則。
 *   - 設定視窗：mountSceneRuleList()——畫場景清單、存規則。
 *   - 主視窗的換色：setScenePresetHandler()——由 uiController.js 交進來。
 * 兩邊只透過 localStorage 交換：主視窗每次切場景都重讀規則，所以不必通知；
 * 開關則由 settingsBindings.js 監聽 storage 事件，再呼叫 applySceneLinkEnabled()。
 */

import {
  onProgramSceneChanged, onSceneListChanged, onSceneRenamed, fetchSceneNames, isObsConnected
} from './obsBridge.js';
import { getSetting, getSettingBool, setSetting, onExternalSettingChange } from './settingsStore.js';
import { setPauseAvailable } from './uiState.js';
import { PRESETS, CUSTOM_SLOTS, CUSTOM_THEMES_KEY, hasCustomTheme } from './subtitlePresets.js';
import { createLogger } from './logger.js';

const log = createLogger('ObsSceneLink');

const ENABLED_KEY = 'obs-scene-link-enabled';
const RULES_KEY = 'obs-scene-rules';
const PRESETS_KEY = 'obs-scene-presets';

/* 選單的順序也照這個。 */
const ACTION_LABELS = { start: '開始', stop: '停止', none: '何もしない' };
/* 沒有記錄的場景的動作。 */
const DEFAULT_ACTION = 'start';

/** @type {(action: 'start'|'stop', sceneName: string) => void} */
let applyAction = () => {};
/** @type {(presetId: string) => void} */
let applyPreset = () => {};
/* 設定視窗是第二個視窗開的：清單只顯示、不能改。 */
let readOnly = false;

function isEnabled() {
  return getSettingBool(ENABLED_KEY);
}

function loadMap(key) {
  try {
    const map = JSON.parse(getSetting(key));
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function saveMap(key, map) {
  setSetting(key, JSON.stringify(map));
}

/** @returns {Record<string, 'stop'|'none'>} */
const loadRules = () => loadMap(RULES_KEY);
const saveRules = (rules) => saveMap(RULES_KEY, rules);
/** @returns {Record<string, string>} 場景名稱 → 配色 id */
const loadPresets = () => loadMap(PRESETS_KEY);
const savePresets = (presets) => saveMap(PRESETS_KEY, presets);

function setListStatus(text) {
  const status = document.getElementById('obs-scene-status');
  if (status) status.textContent = text;
}

function buildSceneRow(sceneName, action, presetId) {
  const row = document.createElement('div');
  row.className = 'settings-row obs-scene-row';
  row.dataset.action = action;

  const label = document.createElement('span');
  label.className = 'settings-row-label obs-scene-name';
  label.textContent = sceneName;
  label.title = sceneName;

  const select = document.createElement('select');
  select.className = 'card-select';
  select.disabled = readOnly;
  for (const [value, text] of Object.entries(ACTION_LABELS)) {
    select.add(new Option(text, value, false, value === action));
  }
  select.addEventListener('change', () => {
    const rules = loadRules();
    if (select.value === DEFAULT_ACTION) delete rules[sceneName];
    else rules[sceneName] = select.value;
    saveRules(rules);
    row.dataset.action = select.value;
  });

  /* 配色：「テーマそのまま」排第一，是每個場景的初始值。第二個視窗也能改（各自一份）。 */
  const colours = document.createElement('select');
  colours.className = 'card-select';
  colours.title = `${sceneName} に切り替えたときの字幕テーマ`;
  colours.add(new Option('テーマそのまま', '', false, !presetId));
  for (const preset of PRESETS) {
    colours.add(new Option(preset.name, preset.id, false, preset.id === presetId));
  }
  /* マイテーマ 也列出來。空的格子也能選（之後存了就會生效），選了空的格子時顏色不變。 */
  for (const slot of CUSTOM_SLOTS) {
    const text = hasCustomTheme(slot.id) ? slot.name : `${slot.name}（空き）`;
    colours.add(new Option(text, slot.id, false, slot.id === presetId));
  }
  colours.addEventListener('change', () => {
    const presets = loadPresets();
    if (!colours.value) delete presets[sceneName];
    else presets[sceneName] = colours.value;
    savePresets(presets);
  });

  row.append(label, select, colours);
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
  const presets = loadPresets();
  list.replaceChildren(...names.map(name => buildSceneRow(name, rules[name] || DEFAULT_ACTION, presets[name] || '')));
  if (!names.length) setListStatus('シーンがありません');
  else setListStatus(readOnly
    ? '開始・停止は1つ目の窓と同じです。字幕テーマはこの窓の分を選べます'
    : '切り替えたときの動作と字幕テーマをシーンごとに選んでください');
}

function handleProgramSceneChanged(sceneName) {
  if (!isEnabled() || !sceneName) return;
  const action = loadRules()[sceneName] || DEFAULT_ACTION;
  const presetId = loadPresets()[sceneName] || '';
  log.debug(`シーン切替: ${sceneName} → ${ACTION_LABELS[action] || action}、テーマ ${presetId || 'そのまま'}`);
  /* 先換色：不花時間，而且「開始」的場景第一句不該用上一個場景的顏色。 */
  if (presetId) applyPreset(presetId);
  if (action === 'start' || action === 'stop') applyAction(action, sceneName);
}

/* 兩個主視窗都會收到同一次改名。開始・停止的規則是共用的，先存的那邊搬走，
   另一邊就找不到舊名稱；配色規則各自一份，各搬各的。 */
function handleSceneRenamed(oldName, newName) {
  if (!oldName || !newName) return;
  for (const key of [RULES_KEY, PRESETS_KEY]) {
    const map = loadMap(key);
    if (!(oldName in map)) continue;
    map[newName] = map[oldName];
    delete map[oldName];
    saveMap(key, map);
  }
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

/**
 * 主視窗：場景要求換配色時的處理（uiController.js 提供，實際是 subtitlePresets.js 的 applyPreset）。
 * 配色要碰設定畫面的 DOM，不在這裡直接呼叫，和 onAction 一樣由外面交進來。
 * @param {(presetId: string) => void} fn
 */
export function setScenePresetHandler(fn) {
  applyPreset = fn;
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
 * 主視窗搬動規則（場景改名）、或第一個視窗改了規則時也重畫（第二個視窗的清單跟著變）。
 * @param {{ readOnly?: boolean }} [options] readOnly：第二個視窗用，選單不能改
 */
export function mountSceneRuleList({ readOnly: isReadOnly = false } = {}) {
  readOnly = isReadOnly;
  onSceneListChanged(refreshSceneList);
  // 主視窗存了マイテーマ時也重畫，「（空き）」的標示才會跟上。
  onExternalSettingChange([RULES_KEY, PRESETS_KEY, CUSTOM_THEMES_KEY], refreshSceneList);
  document.getElementById('obs-scene-refresh-btn')?.addEventListener('click', refreshSceneList);
}
