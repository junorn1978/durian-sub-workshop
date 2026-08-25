/**
 * @file uiState.js
 * @description Shared DOM-only UI helpers used across speech and translation flows.
 */

import { publishSourceTextToObs, publishTranslationsToObs } from './obsBridge.js';

export function updateStatusDisplay(text, details = null) {
  const statusDisplay = document.getElementById('status-display');
  let displayText = text;
  if (details) {
    const detailStrings = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(', ');
    displayText = `${text} ${detailStrings}`;
  }
  if (statusDisplay && statusDisplay.textContent !== displayText) {
    statusDisplay.textContent = displayText;
  }
}

/**
 * 把起動時的案內訊息在一段時間後清掉。
 * 只有在訊息仍然是當初那一則時才清除：這段期間內若有實際的狀態訊息覆蓋上來，
 * 就不能連它一起吃掉。
 * @param {number} [delayMs]
 */
export function scheduleInitialStatusClear(delayMs = 7000) {
  const statusDisplay = document.getElementById('status-display');
  if (!statusDisplay) return;

  const initialText = statusDisplay.textContent;
  setTimeout(() => {
    if (statusDisplay.textContent === initialText) statusDisplay.textContent = '';
  }, delayMs);
}

// 標誌（暫停按鈕）的說明。錄音中與暫停期間按下時的作用不同。
const PAUSE_BUTTON_HINTS = {
  recording: { label: '一時停止', title: 'クリックで一時停止（設定した時間が過ぎると自動で再開します）' },
  paused: { label: '一時停止の残り時間をリセット', title: 'クリックで残り時間を設定した長さに戻します' }
};

/**
 * 統一切換錄音操作按鈕的啟用狀態。
 * 在 'paused' 狀態下，可透過「開始」立即恢復、「停止」取消自動恢復，或按標誌重設剩餘時間，
 * 因此三個按鈕皆設為可按下狀態。
 * @param {'idle'|'recording'|'paused'} state
 */
export function setRecognitionControlsState(state) {
  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');
  const pauseButton = document.getElementById('pause-recording');
  if (!startButton || !stopButton) return;

  startButton.disabled = state === 'recording';
  stopButton.disabled = state === 'idle';
  if (pauseButton) pauseButton.disabled = state === 'idle';
}

/**
 * 更新標誌上的暫停徽章。
 * @param {boolean} paused 是否處於暫停狀態
 * @param {string} remainingText 暫停期間顯示的剩餘時間（例如 '2:45'）
 */
export function setPauseOverlayState(paused, remainingText = '') {
  const pauseButton = document.getElementById('pause-recording');
  const titleEl = document.getElementById('logo-pause-title');
  const timeEl = document.getElementById('logo-pause-time');

  if (pauseButton) {
    const hint = paused ? PAUSE_BUTTON_HINTS.paused : PAUSE_BUTTON_HINTS.recording;
    pauseButton.classList.toggle('is-paused', paused);
    pauseButton.title = hint.title;
    pauseButton.setAttribute('aria-label', hint.label);
  }
  if (titleEl) titleEl.textContent = paused ? '一時停止中' : '⏸ 一時停止';
  if (timeEl) timeEl.textContent = paused ? remainingText : '';
}

export function clearAllTextElements() {
  const els = document.querySelectorAll('#source-text, #target-text-1, #target-text-2, #target-text-3');
  for (const el of els) {
    try {
      if (el.getAnimations) el.getAnimations().forEach(animation => animation.cancel());
    } catch (_) {
      // 動畫取消失敗不影響清除字幕本身，繼續往下清空文字即可。
    }
    el.textContent = '';
  }

  publishSourceTextToObs('');
  publishTranslationsToObs([]);
}
