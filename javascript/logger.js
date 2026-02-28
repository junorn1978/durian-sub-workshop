/**
 * @file logger.js
 * @description 極簡化日誌控制模組。
 */

/**
 * 動態取得目前的日誌設定狀態
 * @returns {boolean} 是否顯示日誌
 */
export function isDebugEnabled() {
  const isDebugMode = new URLSearchParams(window.location.search).get('debug') === 'true';
  const savedPref = localStorage.getItem('log-level-preference');
  return isDebugMode || savedPref === 'true';
}

/**
 * 設定是否啟用日誌 (此函式保留供 uiController.js 呼叫儲存用)
 * @param {boolean|string} enabled 
 */
export function setLogLevel(enabled) {
  const val = (enabled === true || enabled === 'true' || enabled === 1 || enabled === '1');
  localStorage.setItem('log-level-preference', val ? 'true' : 'false');
}
