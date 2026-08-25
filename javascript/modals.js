/**
 * @file modals.js
 * @description 對話框的開關與 Esc 堆疊。點擊背景不會關閉。
 *
 * 說明用的對話框會疊在設定對話框上方，因此開啟中的對話框以堆疊管理：
 * Esc 只關掉最上層那個，疊放深度寫進 --modal-depth 交給 CSS 換算 z-index
 * （基準值留在 CSS，JS 不重複持有這個數字）。
 *
 * 顯示切換必須是 display: none ↔ flex，CSS 的 @starting-style 入場動畫
 * 掛在這個切換上，改成 hidden 屬性或 class 會讓動畫失效。
 */

/** @type {Array<{ close: () => void }>} 目前開啟中的對話框，最後一個是最上層。 */
const openStack = [];

let escapeBound = false;

/** Esc 只由最上層的對話框處理，因此整頁只需要一個監聽器。 */
const bindEscapeOnce = () => {
  if (escapeBound) return;
  escapeBound = true;

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || openStack.length === 0) return;
    event.preventDefault();
    openStack[openStack.length - 1].close({ restoreFocus: true });
  });
};

/**
 * 綁定一組「開啟按鈕 ／ 對話框 ／ 關閉按鈕」。點擊背景不會關閉。
 * @param {{ overlayId: string, openButtonId: string, closeButtonId?: string }} options
 * @returns {{ open: () => void, close: (opts?: { restoreFocus?: boolean }) => void, isOpen: () => boolean } | null}
 */
export function setupModal({ overlayId, openButtonId, closeButtonId } = {}) {
  const overlay = document.getElementById(overlayId);
  const openButton = document.getElementById(openButtonId);
  if (!overlay || !openButton) return null;

  const controller = {
    isOpen: () => openStack.includes(controller),

    open() {
      if (controller.isOpen()) return;
      openStack.push(controller);
      overlay.style.setProperty('--modal-depth', String(openStack.length));
      overlay.style.display = 'flex';
    },

    close({ restoreFocus = false } = {}) {
      const index = openStack.indexOf(controller);
      if (index === -1) return;
      openStack.splice(index, 1);
      overlay.style.display = 'none';
      overlay.style.removeProperty('--modal-depth');
      if (restoreFocus) openButton.focus();
    }
  };

  openButton.addEventListener('click', () => controller.open());
  document.getElementById(closeButtonId)?.addEventListener('click', () => controller.close({ restoreFocus: true }));
  bindEscapeOnce();

  return controller;
}
