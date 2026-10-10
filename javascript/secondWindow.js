/**
 * @file secondWindow.js
 * @description 第二個視窗（index.html?ch=2）。連動時用來聽另一個音源（對方的 Discord 等），
 * 與第一個視窗各自辨識、各自送到 OBS（見 settingsStore.js 與 obsBridge.js 的 ch）。
 *
 * 第一個視窗：左下「タブの音声」右邊的按鈕打開它。已經開著就只叫到前面——
 *   用同一個名稱再 window.open(網址) 會重新載入那個視窗，辨識中的話就斷了。
 * 第二個視窗：不顯示按鈕（不能再開第三個：太多使用者不好管理）。
 *   用庫洛米配色和標題的（2）來區分，這兩樣在 index.html 的 <head> 就先決定好。
 *
 * OBS 的視窗擷取分得開同一個 Chrome 程序的兩個視窗（2026-10-10 實測）。之前以為
 * 分不開，其實是 OBS 裡兩個來源是同一個來源的「參照」。
 */

import { CHANNEL } from './settingsStore.js';

const WINDOW_NAME = 'hamham-ch2';

function openSecondWindow() {
  const url = new URL(location.href);
  url.searchParams.set('ch', '2');
  url.hash = '';
  // 跟這個視窗一樣大的獨立小視窗（沒有分頁列）。
  const features = `popup,width=${window.outerWidth},height=${window.outerHeight}`;
  /* 先用空網址拿：已經開著就拿到那個視窗而不重新載入；沒開著會得到一個 about:blank。 */
  const win = window.open('', WINDOW_NAME, features);
  if (!win) {
    alert('2つ目の窓を開けませんでした。ブラウザのポップアップのブロックを解除してください。');
    return;
  }
  if (win.location.href === 'about:blank') win.location.href = url.href;
  win.focus();
}

/** 頁面載入時呼叫一次。 */
export function mountSecondWindow() {
  const button = document.getElementById('second-window-btn');
  if (!button) return;
  if (CHANNEL === 2) {
    button.hidden = true;
    return;
  }
  button.addEventListener('click', openSecondWindow);
}
