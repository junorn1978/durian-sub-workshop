/**
 * @file uiController.js
 * @description UI 介面控制核心，管理所有樣式設定、語言選單、翻譯模式切換及 localStorage 持久化。
 */

import { updateStatusDisplay } from './uiState.js';
import { setupLanguagePackButton } from './languagePackManager.js';
import { browserInfo, loadLanguageConfig, setAlignment, setForceSingleLineStatus, setSpeechEngine } from './config.js';
import { isDebugEnabled, setLogLevel } from './logger.js';
import { handleObsBridgeSettingsChanged, triggerAutoSetup, testObsConnection } from './obsBridge.js';
import { translateTestText } from './translationController.js';

const setupToggleVisibility = (btnId, inputId) => {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (btn && input) {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMasked = input.classList.contains('input-masked');
      input.classList.toggle('input-masked', !isMasked);
      input.classList.toggle('input-visible', isMasked);

      const eyeOpen = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
      const eyeClosed = `<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      newBtn.innerHTML = isMasked ? eyeOpen : eyeClosed;
    });
  }
};

const updateObsDragLink = () => {
  const linkEl = document.getElementById('obs-drag-link');
  const linkSourceEl = document.getElementById('obs-drag-link-source');
  const linkTarget1El = document.getElementById('obs-drag-link-target1');
  const linkTarget2El = document.getElementById('obs-drag-link-target2');
  const linkTarget3El = document.getElementById('obs-drag-link-target3');

  const ip = (document.getElementById('obs-ws-ip')?.value || '127.0.0.1').trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '') || '127.0.0.1';
  const port = (document.getElementById('obs-ws-port')?.value || '4455').trim() || '4455';
  const url = `ws://${ip}:${port}`;
  const pwd = document.getElementById('obs-ws-password')?.value || '';

  const baseUrl = window.location.href.split('?')[0].replace(/index\.html$/, '').replace(/\/$/, '');

  const setupLink = (el, fileName, mode) => {
    if (!el) return;
    const overlayUrl = `${baseUrl}/${fileName}`;
    const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    el.href = `${overlayUrl}#url=${encodeURIComponent(url)}&pwd=${encodeURIComponent(pwd)}${modeParam}`;
  };

  setupLink(linkEl, 'obs_overlay.html');
  setupLink(linkSourceEl, 'obs_overlay.html', 'source');
  setupLink(linkTarget1El, 'obs_overlay.html', 'target1');
  setupLink(linkTarget2El, 'obs_overlay.html', 'target2');
  setupLink(linkTarget3El, 'obs_overlay.html', 'target3');
};
document.addEventListener('DOMContentLoaded', async function () {
  const urlParams = new URLSearchParams(window.location.search);
  const isDebugMode = urlParams.get('debug') === 'true';

  const savedDebug = localStorage.getItem('log-system-debug-enabled');
  // 如果 localStorage 已經有設定，則維持現狀；否則看 isDebugMode。
  // 這樣即便網址帶有 ?debug=true，第二次以後若在 UI 關閉，它也會遵循 localStorage 的設定。
  if (savedDebug === null) {
    setLogLevel(isDebugMode);
  }

  if (isDebugEnabled()) console.info('UI', '應用程式初始化開始...');

  setTimeout(() => {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) statusDisplay.textContent = '';
  }, 7000);

  // #region [UI 配置定義]
  /** @type {Object} 系統統一設定配置表 */
  const CONFIG = {
    styles: [
      { id: 'source-font-color', target: 'source-text', css: '--text-color', type: 'color' },
      { id: 'target1-font-color', target: 'target-text-1', css: '--text-color', type: 'color' },
      { id: 'target2-font-color', target: 'target-text-2', css: '--text-color', type: 'color' },
      { id: 'target3-font-color', target: 'target-text-3', css: '--text-color', type: 'color' },
      { id: 'source-font-stroke-color', target: 'source-text', css: '--stroke-color', type: 'color' },
      { id: 'target1-font-stroke-color', target: 'target-text-1', css: '--stroke-color', type: 'color' },
      { id: 'target2-font-stroke-color', target: 'target-text-2', css: '--stroke-color', type: 'color' },
      { id: 'target3-font-stroke-color', target: 'target-text-3', css: '--stroke-color', type: 'color' },
      { id: 'source-font-size', target: 'source-text', css: '--text-font-size', type: 'range' },
      { id: 'target1-font-size', target: 'target-text-1', css: '--text-font-size', type: 'range' },
      { id: 'target2-font-size', target: 'target-text-2', css: '--text-font-size', type: 'range' },
      { id: 'target3-font-size', target: 'target-text-3', css: '--text-font-size', type: 'range' },
      { id: 'source-font-stroke-size', target: 'source-text', css: '--stroke-width', type: 'range' },
      { id: 'target1-font-stroke-size', target: 'target-text-1', css: '--stroke-width', type: 'range' },
      { id: 'target2-font-stroke-size', target: 'target-text-2', css: '--stroke-width', type: 'range' },
      { id: 'target3-font-stroke-size', target: 'target-text-3', css: '--stroke-width', type: 'range' }
    ],
    languages: [
      { id: 'source-language', type: 'select' },
      { id: 'target1-language', type: 'select', clearTarget: 'target-text-1' },
      { id: 'target2-language', type: 'select', clearTarget: 'target-text-2' },
      { id: 'target3-language', type: 'select', clearTarget: 'target-text-3' }
    ],
    radioGroups: [
      {
        name: 'alignment', key: 'text-alignment', default: 'center',
        targets: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
        css: '--text-align',
        onApply: (val) => setAlignment(val)
      }
    ],
    special: [
      { id: 'display-panel-color', type: 'body-color', css: '--body-background' },
      { id: 'translation-link', type: 'text' },
      {
        id: 'obs-ws-enabled', type: 'select', key: 'obs-ws-enabled',
        default: 'false',
        onApply: () => handleObsBridgeSettingsChanged()
      },
      {
        id: 'obs-ws-ip', type: 'text',
        onApply: () => { handleObsBridgeSettingsChanged(); updateObsDragLink(); }
      },
      {
        id: 'obs-ws-port', type: 'text',
        onApply: () => { handleObsBridgeSettingsChanged(); updateObsDragLink(); }
      },
      {
        id: 'obs-ws-password', type: 'text',
        onApply: () => { handleObsBridgeSettingsChanged(); updateObsDragLink(); }
      },
      {
        id: 'click-minimize-opt', type: 'select', key: 'click-minimize-enabled', default: 'true'
      },
      {
        id: 'force-single-line-opt', type: 'select', key: 'force-single-line-enabled',
        default: 'true',
        onApply: (val) => {
          const isEnabled = val === 'true';
          setForceSingleLineStatus(isEnabled);
          document.getElementById('source-text')?.classList.toggle('visual-single-line', isEnabled);
        }
      },
      {
        id: 'speech-engine-opt', type: 'select', key: 'speech-recognition-engine', default: 'soniox',
        onApply: (val) => {
          setSpeechEngine(val);
          const isCloud = val === 'soniox';

          const dlBtn = document.getElementById('download-language-pack');
          const dlRow = dlBtn?.closest('.settings-row');
          if (dlRow && browserInfo.isChrome) {
            // 離線語言包僅在 on-device (Web Speech) 引擎時有意義，雲端 (Soniox) 引擎時隱藏
            dlRow.style.display = isCloud ? 'none' : '';
          }

          const helpLink = document.getElementById('engine-help-link');
          if (helpLink) {
            helpLink.style.display = isCloud ? 'inline-flex' : 'none';
          }
        }
      },
      {
        id: 'log-level-opt', type: 'select', key: 'log-level-preference', default: 'false',
        onApply: (val) => setLogLevel(val)
      },
      {
        id: 'auto-stop-enabled-opt', type: 'select', key: 'auto-stop-enabled', default: 'true',
        onApply: (val) => {
          const badge = document.getElementById('auto-stop-warning-badge');
          if (badge) badge.style.display = val === 'false' ? 'inline-block' : 'none';
        }
      },
    ],
    panels: { 'Subtitle': 'source-styles-panel', 'options': 'options-panel' }
  };
  // #endregion

  // #region [瀏覽器功能限制檢查]
  if (!browserInfo.isChrome) {
    if (isDebugEnabled()) console.debug('[DEBUG] [UIController]', '檢測到 Edge 瀏覽器，限制本地端 API 功能');

    const dlBtn = document.getElementById('download-language-pack');
    const dlRow = dlBtn?.closest('.settings-row');
    if (dlRow) dlRow.style.display = 'none';
  }
  // #endregion

  // #region [數據持久化處理器 (Storage)]
  const Storage = {
    save: (key, value) => {
      localStorage.setItem(key, value);
    },
    load: (key, defaultValue = null) => {
      return localStorage.getItem(key) || defaultValue;
    },
    getDefaultFromCSS: (cssProperty) => {
      return getComputedStyle(document.documentElement).getPropertyValue(cssProperty).trim();
    }
  };
  // #endregion

  // #region [工廠函式：設定處理器生成]

  /**
   * 生成標準輸入/樣式處理器
   * @param {Object} config - 設定項物件
   */
  const createSettingHandler = (config) => ({
    load() {
      const element = document.getElementById(config.id);
      const target = config.target ? document.getElementById(config.target) : null;
      if (!element) return;

      const saved = Storage.load(config.id);
      const value = saved || (config.css ? Storage.getDefaultFromCSS(config.css) : null);
      if (!value) return;

      element.value = config.type === 'range' ? parseFloat(value) : value;
      if (!target || !config.css) return;

      target.style.setProperty(config.css, value);
    },
    save(value) {
      Storage.save(config.id, value);
      const target = config.target ? document.getElementById(config.target) : null;
      if (!target || !config.css) return;

      target.style.setProperty(config.css, value);
    },
    setupListener() {
      const element = document.getElementById(config.id);
      if (!element) return;

      element.addEventListener(config.type === 'select' ? 'change' : 'input', (e) => {
        const value = config.type === 'range' ? `${e.target.value}px` : e.target.value;
        this.save(value);
        this.handleSpecialCases(e);
      });
    },
    handleSpecialCases(e) {
      if (!config.clearTarget || e.target.value !== 'none') return;
      const targetEl = document.getElementById(config.clearTarget);
      if (!targetEl) return;
      targetEl.textContent = '\u200B';
    },
    reset() {
      if (!config.css) return;
      const defaultValue = Storage.getDefaultFromCSS(config.css);
      if (!defaultValue) return;
      this.save(defaultValue);
      const element = document.getElementById(config.id);
      if (element) element.value = config.type === 'range' ? parseFloat(defaultValue) : defaultValue;
    }
  });

  /**
   * 生成 Radio 單選按鈕處理器
   * @param {Object} config 
   */
  const createRadioHandler = (config) => ({
    load() {
      const saved = Storage.load(config.key, config.default);

      if (config.onApply) config.onApply(saved, config.targets);

      const radio = document.querySelector(`input[name="${config.name}"][value="${saved}"]`);
      if (radio) {
        radio.checked = true;
        this.save(saved, false); // false = 載入時不再次觸發 onApply，避免重複執行
      }
    },
    setupListener() {
      document.querySelectorAll(`input[name="${config.name}"]`).forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (e.target.checked) this.save(e.target.value, true);
        });
      });
    },
    save(value, triggerCallback = true) {
      Storage.save(config.key, value);

      if (triggerCallback && config.onApply) config.onApply(value, config.targets);

      if (config.css && config.targets) {
        config.targets.forEach(targetId => {
          const target = document.getElementById(targetId);
          if (target) target.style.setProperty(config.css, value);
        });
      }
    },
    reset() {
      if (config.onApply) config.onApply(config.default, config.targets);

      const defaultRadio = document.querySelector(`input[name="${config.name}"][value="${config.default}"]`);
      if (defaultRadio) {
        defaultRadio.checked = true;
        this.save(config.default, false);
      }
    }
  });

  /**
   * 生成特殊元件（Checkbox, Select, Body Color）處理器
   * @param {Object} config 
   */
  const createSpecialHandler = (config) => {
    const handlers = {
      'body-color': {
        load(el) {
          const value = Storage.load(config.id) || Storage.getDefaultFromCSS(config.css) || '#00FF00';
          el.value = value;
          document.body.style.setProperty(config.css, value);
        },
        setupListener(el) {
          el.addEventListener('input', (e) => {
            document.body.style.setProperty(config.css, e.target.value);
            Storage.save(config.id, e.target.value);
          });
        },
        reset(el) {
          const def = Storage.getDefaultFromCSS(config.css) || '#00FF00';
          el.value = def;
          document.body.style.setProperty(config.css, def);
          Storage.save(config.id, def);
        }
      },
      'text': {
        load(el) {
          const saved = Storage.load(config.id);
          if (saved) el.value = saved;
          if (config.onApply) config.onApply(el.value || '');
        },
        setupListener(el) {
          el.addEventListener('input', (e) => {
            Storage.save(config.id, e.target.value);
            if (config.onApply) config.onApply(e.target.value);
          });
        },
        reset() { }
      },
      'checkbox': {
        load(el) {
          const saved = Storage.load(config.key) === 'true';
          el.checked = saved;
          if (config.onApply) config.onApply(saved);
        },
        setupListener(el) {
          el.addEventListener('change', (e) => {
            const checked = e.target.checked;
            Storage.save(config.key, checked.toString());
            if (config.onApply) config.onApply(checked);
          });
        },
        reset(el) {
          el.checked = false;
          Storage.save(config.key, 'false');
          if (config.onApply) config.onApply(false);
        }
      },
      'select': {
        load(el) {
          const saved = Storage.load(config.key);
          const val = saved || config.default || 'false';
          el.value = val;

          if (config.onApply) config.onApply(val);
        },
        setupListener(el) {
          el.addEventListener('change', (e) => {
            const val = e.target.value;
            Storage.save(config.key, val);
            if (config.onApply) config.onApply(val);
          });
        },
        reset(el) {
          const def = config.default || 'false';
          el.value = def;
          Storage.save(config.key, def);
          if (config.onApply) config.onApply(def);
        }
      },
    };

    const handler = handlers[config.type];
    return {
      load() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.load(el);
      },
      setupListener() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.setupListener(el);
      },
      reset() {
        const el = document.getElementById(config.id);
        if (el && handler) handler.reset(el);
      }
    };
  };
  // #endregion

  // #region [介面操作與面板管理]

  /** 面板切換與按鈕狀態管理 */
  const setupPanelSwitching = () => {
    const switchPanel = (buttonId) => {
      // 対応する panel を持たないボタン（OBS連携モーダル等）はタブ切替の対象外
      if (!CONFIG.panels[buttonId]) return;
      document.querySelectorAll('.menu-button').forEach(btn => btn.classList.remove('active'));
      document.getElementById(buttonId)?.classList.add('active');

      Object.values(CONFIG.panels).forEach(pId => {
        const p = document.getElementById(pId);
        if (p) p.style.display = 'none';
      });

      const target = document.getElementById(CONFIG.panels[buttonId]);
      if (target) target.style.display = 'flex';
    };

    document.querySelectorAll('.menu-button').forEach(btn => {
      btn.addEventListener('click', () => switchPanel(btn.id));
    });
  };

  /** 翻譯模式切換邏輯（現行 UI 開放 gtx / link） */
  const setupTranslationModeHandler = () => {
    const modeSelect = document.getElementById('translation-mode');
    const linkWrapper = document.getElementById('link-input-wrapper');

    setupToggleVisibility('toggle-link-visibility', 'translation-link');

    if (!modeSelect) return;

    const applyMode = (mode) => {
      if (linkWrapper) linkWrapper.style.display = 'none';

      switch (mode) {
        case 'link':
          if (linkWrapper) { linkWrapper.style.display = 'block'; document.getElementById('translation-link')?.focus(); }
          break;
      }
      Storage.save('translation-mode-selection', mode);
    };

    const savedMode = Storage.load('translation-mode-selection') || 'gtx';
    modeSelect.value = savedMode;
    applyMode(modeSelect.value);
    
    modeSelect.addEventListener('change', (e) => applyMode(e.target.value));
  };

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
        if (isDebugEnabled()) console.error('[ERROR] [TranslationTest]', error);
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

  /** 字幕面板點擊切換最小化 (擴大字幕區) */
  const setupDisplayPanelInteraction = () => {
    const dPanel = document.getElementById('display-panel');
    const cPanel = document.getElementById('control-panel');
    const sPanel = document.getElementById('status-panel');
    const minOpt = document.getElementById('click-minimize-opt');
    if (!dPanel || !cPanel || !sPanel) return;

    dPanel.addEventListener('click', () => {
      if (minOpt?.value === 'false') return;
      const isHidden = cPanel.style.display === 'none';
      cPanel.style.display = isHidden ? 'flex' : 'none';
      sPanel.style.display = isHidden ? 'flex' : 'none';
      dPanel.style.setProperty('--display-panel-height', isHidden ? '55%' : '95%');
    });
  };

  /** 全域重置按鈕邏輯 */
  const setupResetButton = (handlers) => {
    const rBtn = document.getElementById('reset-settings');
    if (rBtn) rBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Object.values(handlers).flat().forEach(h => { if (h.reset) h.reset(); });
    });
  };
  // #endregion

  // #region [主初始化流程]
  await loadLanguageConfig();

  const handlers = {
    styleHandlers: CONFIG.styles.map(c => { const h = createSettingHandler(c); h.load(); h.setupListener(); return h; }),
    languageHandlers: CONFIG.languages.map(c => { const h = createSettingHandler(c); h.load(); h.setupListener(); return h; }),
    radioHandlers: CONFIG.radioGroups.map(c => { const h = createRadioHandler(c); h.load(); h.setupListener(); return h; }),
    specialHandlers: CONFIG.special.map(c => { const h = createSpecialHandler(c); h.load(); h.setupListener(); return h; })
  };

  setupPanelSwitching();
  setupResetButton(handlers);
  await setupLanguagePackButton('source-language', updateStatusDisplay);
  setupDisplayPanelInteraction();
  setupTranslationModeHandler();
  setupTranslationTestTool();
  setupToggleVisibility('toggle-obs-pwd-visibility', 'obs-ws-password');

  // OBS連携モーダルの開閉（ボタンで開く・✕／Esc で閉じる・背景クリックでは閉じない）
  (() => {
    const overlay = document.getElementById('obs-modal-overlay');
    const openBtn = document.getElementById('obs-settings');
    const closeBtn = document.getElementById('obs-modal-close');
    if (!overlay || !openBtn) return;
    const close = () => { overlay.style.display = 'none'; };
    openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
    closeBtn?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') close();
    });

    // 接続テスト：一時接続で OBS まで到達できたら「接続完了」を表示
    const testBtn = document.getElementById('obs-test-btn');
    const testStatus = document.getElementById('obs-test-status');
    testBtn?.addEventListener('click', async () => {
      if (testStatus) { testStatus.textContent = '接続中...'; testStatus.className = 'obs-test-status testing'; }
      testBtn.disabled = true;
      const ok = await testObsConnection();
      testBtn.disabled = false;
      if (testStatus) {
        testStatus.textContent = ok ? '接続完了' : '接続失敗';
        testStatus.className = `obs-test-status ${ok ? 'ok' : 'fail'}`;
      }
    });
  })();

  // その他設定モーダルの開閉（齒輪ボタンで開く・✕／Esc で閉じる・背景クリックでは閉じない）
  (() => {
    const overlay = document.getElementById('settings-modal-overlay');
    const openBtn = document.getElementById('settings-gear');
    const closeBtn = document.getElementById('settings-modal-close');
    if (!overlay || !openBtn) return;
    const close = () => { overlay.style.display = 'none'; };
    openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
    closeBtn?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') close();
    });
  })();

  // 翻訳クラウド接続（カスタム URL）ヘルプモーダルの開閉＋範本コピー
  (() => {
    const overlay = document.getElementById('link-help-modal-overlay');
    const openBtn = document.getElementById('link-help-btn');
    const closeBtn = document.getElementById('link-help-close');
    const copyBtn = document.getElementById('link-help-copy');
    const codeEl = document.getElementById('link-help-code');
    if (!overlay || !openBtn) return;
    const close = () => { overlay.style.display = 'none'; };
    openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
    closeBtn?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') close();
    });
    copyBtn?.addEventListener('click', async () => {
      if (!codeEl) return;
      try {
        await navigator.clipboard.writeText(codeEl.textContent);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ コピーしました';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      } catch (_) { /* clipboard 不可時は無視 */ }
    });
  })();

  // Soniox 説明モーダル（設定モーダル内の ? から開き、その上に重ねる）
  (() => {
    const overlay = document.getElementById('soniox-help-modal-overlay');
    const openBtn = document.getElementById('engine-help-link');
    const closeBtn = document.getElementById('soniox-help-close');
    if (!overlay || !openBtn) return;
    overlay.style.zIndex = '1001'; // 設定モーダル(1000)より前面へ
    const close = () => { overlay.style.display = 'none'; };
    openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
    closeBtn?.addEventListener('click', close);
    // capture で先に処理し、設定モーダルの Esc ハンドラまで伝播させない（重ねている方だけ閉じる）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') {
        close();
        e.stopPropagation();
      }
    }, true);
  })();

  // OBS WebSocket 説明モーダル（OBS連携モーダル内の ? から開き、その上に重ねる）
  (() => {
    const overlay = document.getElementById('obs-help-modal-overlay');
    const openBtn = document.getElementById('obs-help-btn');
    const closeBtn = document.getElementById('obs-help-close');
    if (!overlay || !openBtn) return;
    overlay.style.zIndex = '1001'; // OBS連携モーダル(1000)より前面へ
    const close = () => { overlay.style.display = 'none'; };
    openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
    closeBtn?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') {
        close();
        e.stopPropagation();
      }
    }, true);
  })();

  const defaultTab = document.getElementById('Subtitle');
  if (defaultTab) defaultTab.click();

  updateObsDragLink();
  
  const autoSetupBtn = document.getElementById('obs-auto-setup-btn');
  if (autoSetupBtn) {
    autoSetupBtn.addEventListener('click', () => {
      triggerAutoSetup();
    });
  }
  // #endregion

// #region [Source Text 即時捲動]

  /**
   * Source Text 專用滾動邏輯
   * 特性：即時響應、標準平滑滾動 (Native Smooth Scroll)
   * 適用於：Soniox 或 Web Speech API 的即時語音轉錄顯示
   */
  const setupSourceScrollBehavior = (elementId) => {
    const el = document.getElementById(elementId);
    if (!el) return;

    const observer = new MutationObserver(() => {
      if (el.scrollHeight > el.clientHeight) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth'
        });
      } else {
        el.scrollTop = 0;
      }
    });

    observer.observe(el, { childList: true, characterData: true, subtree: true });
  };

  setupSourceScrollBehavior('source-text');

  // #endregion
});

