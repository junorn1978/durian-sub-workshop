// translationController.js (patched)
import { keywordRules } from './speechCapture.js';
import { loadLanguageConfig, getChunkSize, getDisplayTimeRules, getTargetCodeById, getTargetCodeForTranslator } from './config.js';
import { sendLocalTranslation } from './translatorApiService.js';
import { sendPromptTranslation } from './promptTranslationService.js';

// Chrome Translator API用參數
const translatorCache = new Map();

// 全局序列號計數器
let sequenceCounter = 0;
const maxConcurrent = 5; // 最大並發請求數
let activeRequests = 0; // 當前活動請求數
let bufferCheckInterval = null; // 用於追蹤 setInterval（已不再使用，保留變數避免其他檔案存取出錯）
let lastLogTime = 0;
const LOG_THROTTLE_MS = 1000; // 日誌節流，每 1000ms 記錄一次

// ======= Performance helpers: rAF-based display scheduler & request queue =======
const pendingQueue = [];
const MAX_CONCURRENT = maxConcurrent;
function runWithSemaphore(task) {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        activeRequests--;
        drainQueue();
      });
  }
  return new Promise((resolve, reject) => {
    pendingQueue.push({ task, resolve, reject });
  });
}
function drainQueue() {
  while (activeRequests < MAX_CONCURRENT && pendingQueue.length > 0) {
    const { task, resolve, reject } = pendingQueue.shift();
    activeRequests++;
    Promise.resolve()
      .then(task)
      .then((r) => {
        activeRequests--;
        resolve(r);
        drainQueue();
      })
      .catch((e) => {
        activeRequests--;
        reject(e);
        drainQueue();
      });
  }
}

// rAF display scheduler (replaces setInterval-driven buffer checks)
let rafScheduled = false;
function scheduleDisplayFlush() {
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      flushDisplayOnce();
      // keep flushing while there is data
      if (['target1','target2','target3'].some(k => displayBuffers[k]?.length > 0)) {
        scheduleDisplayFlush();
      }
    });
  }
}
function pushDisplayBuffer(key, item) {
  if (!displayBuffers[key]) displayBuffers[key] = [];
  displayBuffers[key].push(item);
  if (displayBuffers[key].length > 50) {
    displayBuffers[key] = displayBuffers[key].slice(-50);
  }
  scheduleDisplayFlush();
}
function flushDisplayOnce() {
  const now = Date.now();
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };
  ['target1','target2','target3'].forEach(key => {
    const span = spans[key];
    if (!span) return;
    // expire old entries (10s)
    const buf = (displayBuffers[key] || []).filter(it => now - it.timestamp < 10000);
    displayBuffers[key] = buf;
    const cur = currentDisplays[key];
    if (cur && (now - cur.startTime) < (cur.minDisplayTime * 1000)) return;
    if (buf.length === 0) return;
    const lastSeq = cur?.sequenceId ?? -1;
    const idx = buf.findIndex(it => it.sequenceId > lastSeq);
    if (idx === -1) return;
    const next = buf.splice(idx, 1)[0];
    currentDisplays[key] = {
      text: next.text,
      startTime: now,
      minDisplayTime: next.minDisplayTime,
      sequenceId: next.sequenceId
    };
    // pure write: avoid forced reflow
    span.textContent = next.text;
    span.dataset.stroke = next.text;
    const langSelect = document.getElementById(`${key}-language`)?.value;
    const chunkSize = getChunkSize(langSelect) || 40;
    span.classList.toggle('multi-line', next.text.length > chunkSize);
  });
}
// ===============================================================================

// 顯示緩衝區與當前顯示物件
const displayBuffers = {
  target1: [],
  target2: [],
  target3: []
};
const currentDisplays = {
  target1: null,
  target2: null,
  target3: null
};

// 工具函式
function timeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); })
           .catch((e) => { clearTimeout(t); reject(e); });
  });
}

function isPromptApiAvailable() {
  return typeof window !== 'undefined' && 'ai' in window && typeof window.ai?.languageModel === 'function';
}

function buildStatusDetails(obj) {
  return obj ? Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(', ') : '';
}

// 更新status-panel的訊息用
function updateStatusDisplay(text, details = null) {
  const statusDisplay = document.getElementById('status-display');
  let displayText = text;
  if (details) {
    const detailStrings = Object.entries(details)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    displayText = `${text} ${detailStrings}`;
  }
  if (statusDisplay) {
    // 僅在文字不同時更新，避免多餘重繪
    if (statusDisplay.textContent !== displayText) {
      statusDisplay.textContent = displayText;
    }
  }
}

// 取得瀏覽器資訊
function getBrowserInfo() {
  const ua = navigator.userAgent || '';
  return { ua };
}

// 主流程：送出翻譯請求（加入佇列，避免並發 thrash）
async function sendTranslationRequest(text, sourceLang, browserInfo, isLocalTranslationActive) {
  return runWithSemaphore(async () => {
    const sequenceId = sequenceCounter++;
    console.info('[DEBUG] [Translation] queued/start:', { activeRequests, sequenceId, timestamp: Date.now() });

    try {
      if (!text || !text.trim()) {
        console.warn('[WARN] [Translation] 空白內容，略過請求');
        return;
      }

      // 目標語言設定（從 UI 讀取）
      const targetLangs = [
        document.getElementById('target1-language')?.value,
        document.getElementById('target2-language')?.value,
        document.getElementById('target3-language')?.value
      ].filter(Boolean);

      const displayTimeRules = getDisplayTimeRules();
      const minDisplayTime = displayTimeRules?.minSeconds ?? 1.0;

      // 選擇使用本地/雲端/Prompt API
      const isPromptApiActive = document.getElementById('new-translator-toggle')?.classList.contains('active');
      let data = null;

      if (isLocalTranslationActive) {
        data = await sendLocalTranslation(text, targetLangs, sourceLang);
      } else if (isPromptApiActive && isPromptApiAvailable()) {
        data = await sendPromptTranslation(text, targetLangs, sourceLang);
      } else {
        // 後端 REST 版本（保留原有路徑）
        const url = new URL('/api/translate', location.origin);
        url.searchParams.set('text', text);
        url.searchParams.set('source', sourceLang || 'auto');
        url.searchParams.set('targets', targetLangs.join(','));
        const response = await timeout(fetch(url, { method: 'GET', mode: 'cors' }), 10000);
        if (!response.ok) {
          throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
        }
        data = await response.json();
      }

      if (data) {
        await updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId);
      } else {
        console.warn('[WARN] [Translation] 無有效翻譯結果:', { text, sequenceId });
      }
    } catch (error) {
      console.error('[ERROR] [Translation] 翻譯失敗:', { sequenceId, error: error.message });
      updateStatusDisplay('翻訳エラー:', { sequenceId, error: error.message });
      setTimeout(() => updateStatusDisplay(''), 5000);
    }
  });
}

// 更新 UI：把結果丟到顯示緩衝（rAF 單幀批次刷新）
async function updateTranslationUI(data, targetLangs, minDisplayTime, sequenceId) {
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };
  const isRayModeActive = document.getElementById('raymode')?.classList.contains('active') || false;

  console.debug('[DEBUG] [Translation] updateTranslationUI 開始:', { 
    data: data, 
    targetLangs: targetLangs, 
    sequenceId: sequenceId, 
    translations: data?.translations 
  });

  if (!data || !Array.isArray(data.translations)) {
    console.warn('[WARN] [Translation] 更新 UI：回傳結構異常');
    return;
  }

  data.translations.forEach((t, index) => {
    const key = `target${index + 1}`;
    const span = spans[key];
    if (!span) return;

    const targetLang = targetLangs[index] || 'auto';
    let filteredText = (t?.text || '').toString();

    // RayMode 過濾（依照你的 keywordRules）
    if (isRayModeActive) {
      try {
        filteredText = keywordRules(filteredText, targetLang);
      } catch {}
    }

    // 推入顯示緩衝；不再用 setInterval / 排序 / 強制回流
    pushDisplayBuffer(key, {
      text: filteredText,
      minDisplayTime,
      sequenceId: (data.sequenceId ?? sequenceId),
      timestamp: Date.now()
    });
  });

  /* rAF scheduler will handle flushing; no setInterval needed */
}

// 處理顯示緩衝區（為向後相容保留名稱；實作已切到 rAF 單次刷新）
function processDisplayBuffers() { /* replaced by rAF scheduler */ flushDisplayOnce(); }

// 對外匯出
export { sendTranslationRequest, sequenceCounter, translatorCache, processTranslationUrl, updateStatusDisplay, updateTranslationUI };
