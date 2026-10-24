/**
 * @file uiController.js
 * @description 畫面的組裝點。負責把各個 UI 元件接起來並決定初始化順序。
 *
 * 設定項目的定義與存取搬到 settingsBindings.js／settingsStore.js，
 * 對話框搬到 modals.js。這裡不再放「某個設定要存到哪個 key」這類知識。
 */

import { updateStatusDisplay, scheduleInitialStatusClear } from './uiState.js';
import { setupLanguagePackButton } from './languagePackManager.js';
import { loadLanguageConfig } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { getSetting, setSetting, hasStoredSetting, onExternalSettingChange, CHANNEL } from './settingsStore.js';
import { bindSettings } from './settingsBindings.js';
import { setupToggleVisibility } from './visibilityToggle.js';
import { isObsConnected, onObsConnectionChange, republishSubtitlesToObs } from './obsBridge.js';
import { setScenePresetHandler } from './obsSceneLink.js';
import { mountSubtitlePresets, applyPreset } from './subtitlePresets.js';
import { translateTestText } from './translationController.js';
import { setupColorPickers } from './colorPicker.js';
import { setupModal } from './modals.js';

const log = createLogger('UI');

// #region [小型元件]

/** 管理面板切換與選單按鈕狀態。 */
const setupPanelSwitching = (panels) => {
  const switchPanel = (buttonId) => {
    // 沒有對應面板的按鈕（例如 OBS連携：它開成另一個視窗）不列入分頁切換對象。
    if (!panels[buttonId]) return;
    document.querySelectorAll('.menu-button').forEach(btn => btn.classList.remove('active'));
    document.getElementById(buttonId)?.classList.add('active');

    Object.values(panels).forEach(panelId => {
      const panel = document.getElementById(panelId);
      if (panel) panel.style.display = 'none';
    });

    const target = document.getElementById(panels[buttonId]);
    if (target) target.style.display = 'flex';
  };

  document.querySelectorAll('.menu-button').forEach(btn => {
    btn.addEventListener('click', () => switchPanel(btn.id));
  });
};

/**
 * 管理翻譯模式切換。目前的 UI 支援 gtx／link。
 *
 * 翻訳モード與翻訳クラウド接続的網址兩個視窗共用一份（Soniox 也從這個網址拿連線資訊）：
 *   - 另一個視窗改了，這裡馬上跟著換，不用重新整理。
 *   - 只能在第一個視窗改。第二個視窗的欄位不能改，網址的「顯示」按鈕也拿掉。
 */
const setupTranslationModeHandler = () => {
  const modeSelect = document.getElementById('translation-mode');
  const linkWrapper = document.getElementById('link-input-wrapper');
  const linkInput = document.getElementById('translation-link');
  if (!modeSelect) return;

  const showMode = (mode) => {
    if (linkWrapper) linkWrapper.hidden = mode !== 'link';
  };
  const applyMode = (mode) => {
    showMode(mode);
    if (mode === 'link') linkInput?.focus();
    setSetting('translation-mode-selection', mode);
  };

  modeSelect.value = getSetting('translation-mode-selection');
  applyMode(modeSelect.value);

  modeSelect.addEventListener('change', (event) => applyMode(event.target.value));

  // 另一個視窗改的：只更新畫面，不再寫回去。
  onExternalSettingChange(['translation-mode-selection'], () => {
    modeSelect.value = getSetting('translation-mode-selection');
    showMode(modeSelect.value);
  });
  onExternalSettingChange(['translation-link'], () => {
    if (linkInput) linkInput.value = getSetting('translation-link');
  });

  if (CHANNEL === 2) {
    const note = '翻訳の設定は1つ目の窓で変更します';
    modeSelect.disabled = true;
    modeSelect.title = note;
    if (linkInput) {
      linkInput.disabled = true;
      linkInput.title = note;
    }
    const eyeButton = document.getElementById('toggle-link-visibility');
    if (eyeButton) eyeButton.hidden = true;
  }
};

/** 點擊字幕面板時收合操作面板，擴大字幕區域。 */
const setupDisplayPanelInteraction = () => {
  const displayPanel = document.getElementById('display-panel');
  const controlPanel = document.getElementById('control-panel');
  const statusPanel = document.getElementById('status-panel');
  const minimizeOpt = document.getElementById('click-minimize-opt');
  if (!displayPanel || !controlPanel || !statusPanel) return;

  displayPanel.addEventListener('click', () => {
    if (minimizeOpt?.value === 'false') return;
    const isHidden = controlPanel.style.display === 'none';
    controlPanel.style.display = isHidden ? 'flex' : 'none';
    statusPanel.style.display = isHidden ? 'flex' : 'none';
    displayPanel.style.setProperty('--display-panel-height', isHidden ? '55%' : '95%');
  });
};

/** 全部重設按鈕的處理。 */
const setupResetButton = (resetAll, syncColorPickers, syncPresets) => {
  document.getElementById('reset-settings')?.addEventListener('click', (event) => {
    event.stopPropagation();
    resetAll();
    syncColorPickers();
    syncPresets();
  });
};

/**
 * Source Text 專用的捲動處理。
 * 以標準 smooth scroll 追蹤顯示 Soniox 或 Web Speech API 的即時轉錄內容。
 * 即時轉錄一次更新會產生多個 mutation，因此用 rAF 合併成每幀一次，
 * 避免 smooth 動畫不斷被自己重新啟動而抖動。
 */
const setupSourceScrollBehavior = (elementId) => {
  const element = document.getElementById(elementId);
  if (!element) return;

  let scrollScheduled = false;
  const scrollToBottom = () => {
    scrollScheduled = false;
    if (element.scrollHeight > element.clientHeight) {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
      element.scrollTop = 0;
    }
  };

  const observer = new MutationObserver(() => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(scrollToBottom);
  });

  observer.observe(element, { childList: true, characterData: true, subtree: true });
};

/** 翻訳テストツール（テキスト翻訳ページ）。 */
const setupTranslationTestTool = () => {
  const input = document.getElementById('translation-test-input');
  const runBtn = document.getElementById('translation-test-run');
  const clearBtn = document.getElementById('translation-test-clear');
  const status = document.getElementById('translation-test-status');
  const result = document.getElementById('translation-test-result');

  if (!input || !runBtn || !clearBtn || !status || !result) return;

  const setStatus = (text) => { status.textContent = text || ''; };

  const renderResults = (payload) => {
    result.replaceChildren();

    const activeResults = payload?.results?.filter(item => item.langId && item.langId !== 'none') || [];
    if (activeResults.length === 0) {
      setStatus('翻訳先言語が選択されていません');
      return;
    }

    activeResults.forEach(item => {
      const row = document.createElement('div');
      row.className = 'translation-test-result-row';

      const label = document.createElement('span');
      label.className = 'translation-test-result-label';
      label.textContent = `翻訳 ${item.slot}: ${item.label}`;

      const text = document.createElement('div');
      text.className = 'translation-test-result-text';
      text.textContent = item.text || '';

      row.append(label, text);
      result.append(row);
    });
  };

  const run = async () => {
    const text = input.value.trim();
    if (!text) {
      setStatus('テキストを入力してください');
      result.replaceChildren();
      return;
    }

    runBtn.disabled = true;
    setStatus('翻訳中...');

    try {
      const payload = await translateTestText(text);
      if (!payload) {
        setStatus('翻訳結果がありません');
        result.replaceChildren();
        return;
      }
      renderResults(payload);
      setStatus('');
    } catch (error) {
      log.error('翻訳テストに失敗:', error);
      setStatus(`翻訳エラー: ${error.message}`);
    } finally {
      runBtn.disabled = false;
    }
  };

  runBtn.addEventListener('click', run);
  clearBtn.addEventListener('click', () => {
    input.value = '';
    setStatus('');
    result.replaceChildren();
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });
};
// #endregion

// #region [對話框]

/**
 * 對話框的清單。說明用的（翻訳クラウド接続／Soniox）會疊在設定對話框上方，
 * 疊放順序與 Esc 的處理都由 modals.js 的堆疊負責。
 * OBS連携 不在這裡：它開成另一個視窗（見 setupObsSettingsWindow）。
 */
const MODALS = [
  { overlayId: 'settings-modal-overlay', openButtonId: 'settings-gear', closeButtonId: 'settings-modal-close' },
  { overlayId: 'link-help-modal-overlay', openButtonId: 'link-help-btn', closeButtonId: 'link-help-close' },
  { overlayId: 'soniox-help-modal-overlay', openButtonId: 'engine-help-link', closeButtonId: 'soniox-help-close' }
];

/** 翻訳クラウド接続の說明對話框裡的「複製範例程式碼」。 */
const setupLinkHelpCopy = () => {
  const copyBtn = document.getElementById('link-help-copy');
  const codeEl = document.getElementById('link-help-code');
  if (!copyBtn || !codeEl) return;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      const original = copyBtn.textContent;
      copyBtn.textContent = '✓ コピーしました';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    } catch (_) { /* 無法使用剪貼簿時不進行任何處理。 */ }
  });
};

/**
 * 「OBS連携」按鈕：另開設定視窗（obs_settings.html）。
 * 開在這個頁面裡的話，OBS 的ウィンドウキャプチャ會把設定畫面（含場景名稱）拍進直播。
 * 已經開著就叫到前面，不重新載入。ch2 開的只顯示設定，能做的只有加 HamHam字幕2 的來源。
 */
const setupObsSettingsWindow = () => {
  let settingsWindow = null;
  document.getElementById('obs-settings')?.addEventListener('click', () => {
    if (settingsWindow && !settingsWindow.closed) {
      settingsWindow.focus();
      return;
    }
    const query = CHANNEL === 2 ? '?ch=2' : '';
    settingsWindow = window.open(`obs_settings.html${query}`, `hamham-obs-settings-${CHANNEL}`, 'popup,width=920,height=640');
  });
};

const OBS_CONNECTED_INTRO_TEXT = 'OBS 接続済み';

/**
 * 讓直播主打開頁面時確認有沒有連上 OBS。沒連上（含沒開 OBS WebSocket）就什麼都不顯示。
 *   - 「OBS連携」按鈕上的綠點：連上時才亮。
 *   - 字幕區第 3 行的開場文字（↓ Notice ↓）換成「OBS 接続済み」，斷線就換回來。
 *     只在開場文字還在時換：開始辨識後這裡是字幕，之後重新連上也不去動它。
 *     這裡只改畫面上的字，送到 OBS 的字幕不受影響（obsBridge.js 送的是自己記的字幕）。
 */
const setupObsConnectionIndicator = () => {
  const button = document.getElementById('obs-settings');
  const introLine = document.getElementById('target-text-2');
  const introText = introLine?.textContent;

  const render = (connected) => {
    button?.classList.toggle('obs-connected', connected);
    if (button) button.title = connected ? 'OBS に接続しています' : '';
    // 開場文字已經被清掉（空字串）時，不能拿空字串來比，否則字幕清空後會被寫上去。
    if (!introLine || !introText) return;
    if (connected && introLine.textContent === introText) introLine.textContent = OBS_CONNECTED_INTRO_TEXT;
    else if (!connected && introLine.textContent === OBS_CONNECTED_INTRO_TEXT) introLine.textContent = introText;
  };
  onObsConnectionChange(render);
  render(isObsConnected());
};
// #endregion

// #region [主要初始化]

/**
 * 日誌等級的開機設定。
 * 使用者在 UI 明確設定過就以該設定為準，只有在從未設定過時才看 ?debug=true，
 * 這樣以 ?debug=true 開啟後，仍可沿用之後透過 UI 停用的設定。
 */
const bootstrapLogLevel = () => {
  if (hasStoredSetting('log-system-debug-enabled')) return;
  const isDebugMode = new URLSearchParams(window.location.search).get('debug') === 'true';
  setLogLevel(isDebugMode);
};

document.addEventListener('DOMContentLoaded', async () => {
  bootstrapLogLevel();
  log.info('應用程式初始化開始...');

  scheduleInitialStatusClear();

  await loadLanguageConfig();

  const { resetAll } = bindSettings();
  const colorPickers = setupColorPickers();
  // 換了配色馬上推給 OBS 的 overlay，不等下一句字幕。シーン連動 的換色也走這裡。
  const subtitlePresets = mountSubtitlePresets({ onApplied: republishSubtitlesToObs });
  setScenePresetHandler(applyPreset);

  setupPanelSwitching({ 'Subtitle': 'source-styles-panel', 'options': 'options-panel' });
  setupResetButton(resetAll, colorPickers.sync, subtitlePresets.sync);
  await setupLanguagePackButton('source-language', updateStatusDisplay);
  setupDisplayPanelInteraction();
  setupTranslationModeHandler();
  setupTranslationTestTool();
  setupToggleVisibility('toggle-link-visibility', 'translation-link');

  MODALS.forEach(setupModal);
  setupLinkHelpCopy();
  setupObsSettingsWindow();
  setupObsConnectionIndicator();

  document.getElementById('Subtitle')?.click();
  setupSourceScrollBehavior('source-text');
});
// #endregion
