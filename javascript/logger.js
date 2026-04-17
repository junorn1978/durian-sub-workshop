/**
 * @file logger.js
 * @description 極簡化日誌控制模組。
 */

/**
 * 動態取得目前的日誌設定狀態
 * @returns {boolean} 是否顯示日誌
 */
export function isDebugEnabled() {
  const savedPref = localStorage.getItem('log-system-debug-enabled');
  
  // 如果使用者在 UI 有明確設定過 (true 或 false)，則以 UI 設定為主
  if (savedPref !== null) {
    return savedPref === 'true';
  }

  // 若沒設定過 (首次開啟)，則看網址參數是否有 ?debug=true
  return new URLSearchParams(window.location.search).get('debug') === 'true';
}

/**
 * 設定是否啟用日誌 (此函式保留供 uiController.js 呼叫儲存用)
 * @param {boolean|string} enabled 
 */
export function setLogLevel(enabled) {
  const val = (enabled === true || enabled === 'true');
  localStorage.setItem('log-system-debug-enabled', val ? 'true' : 'false');
}
