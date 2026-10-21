/**
 * @file visibilityToggle.js
 * @description 密碼・URL 欄位的「顯示／隱藏」按鈕。主視窗與 OBS連携 的設定視窗共用。
 */

const EYE_OPEN_ICON = '<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const EYE_CLOSED_ICON = '<svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

/**
 * 密碼、URL 之類欄位的「顯示／隱藏」切換。
 * 圖示一律由目前的遮蔽狀態算出來，不依賴 HTML 裡寫死的那一份，
 * 兩邊不同步時（例如改了初始 class）也不會顯示錯誤的眼睛。
 */
export const setupToggleVisibility = (buttonId, inputId) => {
  const button = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!button || !input) return;

  const render = () => {
    const isMasked = input.classList.contains('input-masked');
    input.classList.toggle('input-visible', !isMasked);
    button.innerHTML = isMasked ? EYE_CLOSED_ICON : EYE_OPEN_ICON;
    button.setAttribute('aria-pressed', String(!isMasked));
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    input.classList.toggle('input-masked');
    render();
  });

  render();
};
