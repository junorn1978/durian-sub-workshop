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

// ロゴ（一時停止ボタン）の説明。録音中と一時停止中で押したときの意味が変わる。
const PAUSE_BUTTON_HINTS = {
  recording: { label: '一時停止', title: 'クリックで一時停止（設定した時間が過ぎると自動で再開します）' },
  paused: { label: '一時停止の残り時間をリセット', title: 'クリックで残り時間を設定した長さに戻します' }
};

/**
 * 録音操作ボタンの活性状態をまとめて切り替える。
 * 'paused' では「開始」で即再開、「停止」で自動再開の取り消し、ロゴで残り時間のリセットができる
 * よう、3つとも押せる状態にする。
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
 * ロゴ上の一時停止バッジを更新する。
 * @param {boolean} paused 一時停止中かどうか
 * @param {string} remainingText 一時停止中に表示する残り時間（例 '2:45'）
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
      // no-op
    }
    el.textContent = '';
  }

  publishSourceTextToObs('');
  publishTranslationsToObs([]);
}
