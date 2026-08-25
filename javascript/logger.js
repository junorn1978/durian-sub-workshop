/**
 * @file logger.js
 * @description 分級日誌。各模組以 createLogger('模組名') 取得自己的輸出器。
 *
 * 【等級】debug < info < warn < error
 *   debug 追蹤流程用的細節（事件、參數、計時）
 *   info  使用者看得到的狀態變化（開始／停止／一時停止、翻譯送出）
 *   warn  不正常但已自行處理（重試、重連、找不到裝置名稱）
 *   error 功能實際失敗，需要有人知道
 *
 * 【門檻】由「ログ出力」設定決定：
 *   關閉（預設）→ 只輸出 error。真正的失敗不該因為使用者沒開 debug 就無聲消失。
 *   開啟         → 全部輸出。
 *
 * 【為什麼一定要用對 console 方法】
 * console.log 在 DevTools 裡屬於 Info 級，不管內容是什麼都會顯示，等於放棄分級。
 * 因此一律對應到 console.debug／info／warn／error，讓 DevTools 右上角的
 * Verbose／Info／Warnings／Errors 篩選器真的有作用（debug 對應 Verbose，預設收起來）。
 *
 * 輸出格式統一為 `[LEVEL] [Module] 訊息`，前綴由這裡自動加上，呼叫端不必自己拼。
 */

const STORAGE_KEY = 'log-system-debug-enabled';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/** 關閉日誌時仍然保留 error。 */
const THRESHOLD_OFF = LEVEL_WEIGHT.error;
const THRESHOLD_ON = LEVEL_WEIGHT.debug;

function readStoredPreference() {
  const saved = localStorage.getItem(STORAGE_KEY);
  // 使用者在 UI 明確設定過就以該設定為準，沒設定過才看網址的 ?debug=true。
  if (saved !== null) return saved === 'true';
  return new URLSearchParams(window.location.search).get('debug') === 'true';
}

/* 門檻放在記憶體裡，不是每次輸出都去讀 localStorage。
   辨識進行中 debug 訊息的產生頻率很高（每筆 interim 結果、每次畫面更新都有），
   而頁面內只有 setLogLevel() 會改變這個值，因此快取是安全的。
   代價是別的分頁改了設定，這一頁要重新整理才會跟上。 */
let threshold = readStoredPreference() ? THRESHOLD_ON : THRESHOLD_OFF;

/**
 * 目前是否輸出 debug 等級。
 * 保留給「為了組出訊息本身就要花成本」的地方當作前置判斷用。
 * @returns {boolean}
 */
export function isDebugEnabled() {
  return threshold <= LEVEL_WEIGHT.debug;
}

/**
 * 設定是否啟用日誌。
 * 呼叫端有兩個：settingsBindings.js 的「ログ出力」選單（傳入 'true'／'false' 字串），
 * 以及 uiController.js 開機時對 ?debug=true 的判斷（傳入 boolean）。因此兩種型別都收。
 * @param {boolean|string} enabled
 */
export function setLogLevel(enabled) {
  const on = (enabled === true || enabled === 'true');
  localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
  threshold = on ? THRESHOLD_ON : THRESHOLD_OFF;
}

/** 門檻未達時回傳的空函式。共用同一個實體，取用時不必再配置。 */
const NOOP = () => {};

/**
 * 建立一個綁定模組名稱的輸出器。
 *
 * 【為什麼回傳 bind 過的 console 方法，而不是自己包一層函式】
 * 包一層的話，DevTools 的來源連結會指向包裝那一行，於是每一則訊息看起來
 * 都來自 logger.js 的同一個位置，出錯時根本找不到是哪裡叫的：
 *
 *   logger.js:73 [ERROR] [SpeechRecognition] 辨識錯誤: no-speech   ← 沒有用的位置
 *
 * bind 產生的是「繫結函式」，呼叫它不會多出一個 JS 堆疊框，因此 console
 * 仍然把位置算在呼叫端那一行，堆疊展開後第一層也是真正的呼叫處：
 *
 *   speechCapture.js:757 [ERROR] [SpeechRecognition] 辨識錯誤: no-speech
 *
 * 【為什麼用 getter】
 * 若在建立 logger 時就把方法綁好，門檻會被固定在模組載入的那一刻，
 * 之後在 UI 切換「ログ出力」要重新整理才會生效。改成每次取用 log.xxx
 * 時才依當下門檻決定要給輸出器還是空函式。
 * 代價：不要把方法解構出來（const { debug } = log），那會固定住當下狀態。
 *
 * @param {string} moduleName - 顯示在前綴中的模組名，例如 'SpeechRecognition'
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger(moduleName) {
  const bind = (level) => {
    if (LEVEL_WEIGHT[level] < threshold) return NOOP;
    return console[level].bind(console, `[${level.toUpperCase()}] [${moduleName}]`);
  };

  return {
    get debug() { return bind('debug'); },
    get info() { return bind('info'); },
    get warn() { return bind('warn'); },
    get error() { return bind('error'); }
  };
}
