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
import { getSetting, setSetting, hasStoredSetting } from './settingsStore.js';
import { bindSettings } from './settingsBindings.js';
import { triggerAutoSetup, testObsConnection, refreshObsDragLinks } from './obsBridge.js';
import { translateTestText } from './translationController.js';
import { setupColorPickers } from './colorPicker.js';
import { setupModal } from './modals.js';

const log = createLogger('UI');

// #region [小型元件]

const EYE_OPEN_ICON = '<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const EYE_CLOSED_ICON = '<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

/**
 * 密碼、URL 之類欄位的「顯示／隱藏」切換。
 * 圖示一律由目前的遮蔽狀態算出來，不依賴 HTML 裡寫死的那一份，
 * 兩邊不同步時（例如改了初始 class）也不會顯示錯誤的眼睛。
 */
const setupToggleVisibility = (buttonId, inputId) => {
  const button = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!button || !input) return;

  const render = () => {
    const isMasked = input.classList.contains('input-masked');
    input.classList.toggle('input-visible', !isMasked);
    button.innerHTML = isMasked ? EYE_CLOSED_ICON : EYE_OPEN_ICON;
    button.setAttribute('aria-pressed', String(!isMasked));
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    input.classList.toggle('input-masked');
    render();
  });

  render();
};

/** 管理面板切換與選單按鈕狀態。 */
const setupPanelSwitching = (panels) => {
  const switchPanel = (buttonId) => {
    // 沒有對應面板的按鈕（例如 OBS 整合對話框）不列入分頁切換對象。
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

/** 管理翻譯模式切換。目前的 UI 支援 gtx／link。 */
const setupTranslationModeHandler = () => {
  const modeSelect = document.getElementById('translation-mode');
  const linkWrapper = document.getElementById('link-input-wrapper');
  if (!modeSelect) return;

  const applyMode = (mode) => {
    if (linkWrapper) linkWrapper.hidden = mode !== 'link';
    if (mode === 'link') document.getElementById('translation-link')?.focus();
    setSetting('translation-mode-selection', mode);
  };

  modeSelect.value = getSetting('translation-mode-selection');
  applyMode(modeSelect.value);

  modeSelect.addEventListener('change', (event) => applyMode(event.target.value));
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
const setupResetButton = (resetAll, syncColorPickers) => {
  document.getElementById('reset-settings')?.addEventListener('click', (event) => {
    event.stopPropagation();
    resetAll();
    syncColorPickers();
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
 * 對話框的清單。說明用的兩個（Soniox／OBS WebSocket）會疊在設定對話框上方，
 * 疊放順序與 Esc 的處理都由 modals.js 的堆疊負責。
 */
const MODALS = [
  { overlayId: 'obs-modal-overlay', openButtonId: 'obs-settings', closeButtonId: 'obs-modal-close' },
  { overlayId: 'settings-modal-overlay', openButtonId: 'settings-gear', closeButtonId: 'settings-modal-close' },
  { overlayId: 'link-help-modal-overlay', openButtonId: 'link-help-btn', closeButtonId: 'link-help-close' },
  { overlayId: 'soniox-help-modal-overlay', openButtonId: 'engine-help-link', closeButtonId: 'soniox-help-close' },
  { overlayId: 'obs-help-modal-overlay', openButtonId: 'obs-help-btn', closeButtonId: 'obs-help-close' }
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

/** OBS 整合對話框裡的連線測試與自動設定。 */
const setupObsModalActions = () => {
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

  document.getElementById('obs-auto-setup-btn')?.addEventListener('click', () => triggerAutoSetup());
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

  setupPanelSwitching({ 'Subtitle': 'source-styles-panel', 'options': 'options-panel' });
  setupResetButton(resetAll, colorPickers.sync);
  await setupLanguagePackButton('source-language', updateStatusDisplay);
  setupDisplayPanelInteraction();
  setupTranslationModeHandler();
  setupTranslationTestTool();
  setupToggleVisibility('toggle-link-visibility', 'translation-link');
  setupToggleVisibility('toggle-obs-pwd-visibility', 'obs-ws-password');

  MODALS.forEach(setupModal);
  setupLinkHelpCopy();
  setupObsModalActions();

  document.getElementById('Subtitle')?.click();
  refreshObsDragLinks();
  setupSourceScrollBehavior('source-text');
});
// #endregion
