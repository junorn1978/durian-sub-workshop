// logger.js

// 定義日誌等級
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 99 // 不顯示任何訊息
};

// 預設等級 (可在此修改，或透過 setLogLevel 動態修改)
let currentLevel = LogLevel.INFO; 

/**
 * 設定日誌等級
 * @param {number} level - 使用 LogLevel.DEBUG, LogLevel.INFO 等
 */
export function setLogLevel(level) {
  currentLevel = parseInt(level, 10);
}

/**
 * 取得當前時間字串 (可選)
 */
function getTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('zh-TW', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

// 核心 Logger 物件
export const Logger = {
  debug: (tag, ...args) => {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(`%c ${tag}`, 'color: #888;', ...args);
    }
  },

  info: (tag, ...args) => {
    if (currentLevel <= LogLevel.INFO) {
      // Chrome 支援 CSS 樣式讓 info 更顯眼
      console.info(`%c ${tag}`, 'color: #2196F3; font-weight: bold;', ...args);
    }
  },

  warn: (tag, ...args) => {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(`${tag}`, ...args);
    }
  },

  error: (tag, ...args) => {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(`${tag}`, ...args);
    }
  }
};