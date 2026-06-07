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

export function setRecognitionControlsState(isStarting) {
  const startButton = document.getElementById('start-recording');
  const stopButton = document.getElementById('stop-recording');
  if (!startButton || !stopButton) return;

  if (isStarting) {
    startButton.disabled = true;
    stopButton.disabled = false;
  } else {
    startButton.disabled = false;
    stopButton.disabled = true;
  }
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
