/**
 * @file logger.js
 * @description 輕量化日誌管理模組，支援顏色標記與等級過濾。
 */

// #region [日誌等級定義]
/** * @enum {number} 
 */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 99 
};

/** @type {number} 當前日誌顯示門檻 */
let currentLevel = LogLevel.INFO; 
// #endregion

/**
 * 動態設定日誌顯示等級
 * @param {number|string} level - 使用 LogLevel 定義的值
 */
export function setLogLevel(level) {
  currentLevel = parseInt(level, 10);
}

/**
 * 取得 ISO 格式的高解析度時間戳
 * @returns {string} 格式如 "HH:mm:ss.SSS"
 */
function getTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('zh-TW', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

// #region [Logger 核心物件]
/**
 * 全域 Logger 實例，提供帶有 CSS 樣式的控制台輸出
 */
export const Logger = {
  /**
   * @param {string} tag - 模組名稱標籤
   * @param {...any} args - 日誌內容
   */
  debug: (tag, ...args) => {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(`%c ${tag}`, 'color: #888;', ...args);
    }
  },

  /**
   * @param {string} tag 
   * @param {...any} args 
   */
  info: (tag, ...args) => {
    if (currentLevel <= LogLevel.INFO) {
      console.info(`%c ${tag}`, 'color: #2196F3; font-weight: bold;', ...args);
    }
  },

  /**
   * @param {string} tag 
   * @param {...any} args 
   */
  warn: (tag, ...args) => {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(`${tag}`, ...args);
    }
  },

  /**
   * @param {string} tag 
   * @param {...any} args 
   */
  error: (tag, ...args) => {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(`${tag}`, ...args);
    }
  }
};
// #endregion