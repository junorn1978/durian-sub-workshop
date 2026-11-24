/**
 * @file tabPicker.js
 * @description 「タブの音声」窓（tab_picker.html）。主視窗的「タブの音声」按鈕另開。
 *
 * 【為什麼另開視窗】瀏覽器的分頁選擇對話框疊在呼叫它的視窗上，列著其他分頁的標題、
 * 其他程式視窗的縮圖。主視窗常被 OBS 的ウィンドウキャプチャ拍進直播，所以在這個窗呼叫。
 * 同樣的理由，OBS連携 的設定也是另開視窗（obsSettingsWindow.js）。
 *
 * 【和主視窗怎麼溝通】同源，直接呼叫主視窗（window.opener）上 tabAudio.js 開好的入口：
 * 拿到的 MediaStream 整個交過去（ACCEPT_HOOK），結束時請主視窗收掉（CLOSE_HOOK）。
 *
 * 【這個窓要留著】擷取綁在呼叫 getDisplayMedia 的視窗上，這個窓關掉共用就結束。
 * 所以共用中提醒不要關（可以最小化）；主視窗不在了就自己關掉。
 * 窓的大小固定在開窓時的大小（見 tabAudio.js 的 openTabPicker），共用前後都不改，
 * 使用者自己拉的大小也不去動。
 */

import { captureTabAudio, NoTabAudioError, ACCEPT_HOOK, CLOSE_HOOK } from './tabAudio.js';
import { createLogger } from './logger.js';

const log = createLogger('TabPicker');

const button = document.getElementById('tab-picker-btn');
const status = document.getElementById('tab-picker-status');

/** @type {MediaStreamTrack|null} 這個窓交給主視窗的音軌（狀態顯示用，本體由主視窗握著）。 */
let sharedTrack = null;

/** 主視窗（開這個窓的那個）還在、而且有接收的入口嗎。 */
function mainWindow() {
  const main = window.opener;
  try {
    if (main && !main.closed && typeof main[ACCEPT_HOOK] === 'function') return main;
  } catch { /* 不同源（不會發生）就當作沒有 */ }
  return null;
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

function render() {
  const sharing = sharedTrack?.readyState === 'live';
  button.textContent = sharing ? '共有を終了' : '共有するタブを選ぶ';
  button.classList.toggle('is-sharing', sharing);
}

async function pick() {
  const main = mainWindow();
  if (!main) {
    setStatus('メインの窓が見つかりません。メインの窓の「タブの音声」ボタンから開き直してください。', true);
    return;
  }
  button.disabled = true;   // 對話框開著時不要再開一個
  try {
    const stream = await captureTabAudio();
    const track = stream.getAudioTracks()[0];
    main[ACCEPT_HOOK](stream);
    sharedTrack = track;
    /* 瀏覽器那邊結束（「停止共用」、關掉分頁）時，回到可以重選的狀態。主視窗那邊自己也會收到。 */
    track.addEventListener('ended', () => {
      if (sharedTrack !== track) return;
      sharedTrack = null;
      setStatus('共有が終了しました。');
      render();
    });
    setStatus(`「${track.label || 'タブ'}」の音声を共有しています。この窓は最小化してかまいません。`);
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      setStatus('');   // 對話框按取消是使用者自己的決定，不說什麼
    } else if (err instanceof NoTabAudioError) {
      setStatus('音声が共有されていません。選ぶときに「タブの音声も共有する」（ウィンドウなら「アプリの音声も共有する」）をオンにしてください。', true);
    } else {
      log.warn('タブを共有できませんでした:', err);
      setStatus('タブを共有できませんでした。もう一度「共有するタブを選ぶ」を押してください。', true);
    }
  } finally {
    button.disabled = false;
    render();
  }
}

/** 結束共用：請主視窗收掉（主視窗也會把這個窓關掉）。主視窗不在了就只關自己。 */
function finish() {
  const main = mainWindow();
  if (main && typeof main[CLOSE_HOOK] === 'function') main[CLOSE_HOOK]();
  window.close();
}

button.addEventListener('click', () => {
  if (sharedTrack?.readyState === 'live') finish();
  else pick();
});
document.getElementById('tab-picker-close')?.addEventListener('click', finish);

/* 主視窗關掉了（或換了頁），這個窓就沒有用了。主視窗的 pagehide 也會關它，這是保險。 */
setInterval(() => {
  if (!mainWindow()) window.close();
}, 1000);

if (!mainWindow()) {
  setStatus('メインの窓が見つかりません。メインの窓の「タブの音声」ボタンから開き直してください。', true);
  button.disabled = true;
}
render();
