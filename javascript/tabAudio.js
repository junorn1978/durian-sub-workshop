/**
 * @file tabAudio.js
 * @description 從分頁（或視窗）取得音訊，代替麥克風。用途是聽連動對象的聲音：
 * Discord 的分頁或視窗、對方的直播分頁。
 *
 * 由左下角麥克風選單旁的按鈕開關（見 micSelector.js 的 mountTabShareButton），
 * 不在「開始」裡開：開始時跳出列著所有分頁與視窗的對話框，直播畫面上會有隱私問題。
 * 共用中，辨識（開始・暫停恢復）一律聽分頁；停止辨識也不結束共用，只有按鈕或
 * 瀏覽器那邊（「停止共用」、關掉分頁）能結束。
 *
 * 從 即時翻譯 的 audio-input.js（openTabStream）移植過來，參數的實測依據在那邊。
 *
 * 用 getDisplayMedia 共用，這帶來三個限制，呼叫端都要承擔：
 *   - 只能在使用者點擊之後開（所以斷了不能自己重開，也不能在暫停結束時自動開）
 *   - 每次都要在瀏覽器的對話框裡選分頁
 *   - 沒勾「分頁的音訊也共用」就沒有聲音
 *
 * 所以這裡把共用本身握住，交出去的是複製的音軌（cloneTabStream）。辨識引擎照舊在停止時
 * stop() 自己那份，共用不受影響。
 */

import { createLogger } from './logger.js';

const log = createLogger('TabAudio');

/* 前處理全部關掉：分頁的聲音是乾淨的數位訊號，這些是給麥克風用的。
   回音消除甚至可能把正在喇叭播放的分頁聲音當成回音消掉。 */
const PROCESSING_OFF = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** 共用了分頁（或視窗）卻沒有音訊時丟出。 */
export class NoTabAudioError extends Error {
  constructor() { super('the shared surface has no audio'); this.name = 'NoTabAudioError'; }
}

/** @type {MediaStream|null} 共用中的分頁。只留音軌。 */
let share = null;
const changeListeners = new Set();

function notifyChange(active) {
  for (const fn of changeListeners) fn(active);
}

/** 共用中的分頁還活著嗎。 */
export function hasTabShare() {
  return !!share && share.getAudioTracks().some(t => t.readyState === 'live');
}

/** 共用中的分頁的名稱（按鈕的說明用）。 */
export function getTabShareLabel() {
  return share?.getAudioTracks()[0]?.label || '';
}

/**
 * 共用開始・結束時呼叫 fn(active)。結束包括按鈕、瀏覽器上的「停止共用」、關掉分頁。
 * 回傳取消訂閱的函式。
 */
export function onTabShareChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/**
 * 跳出瀏覽器的分頁選擇對話框。必須在點擊的處理裡呼叫。
 * 已經在共用就直接沿用，不再問。
 * 使用者取消時是 NotAllowedError；沒勾音訊時是 NoTabAudioError。
 */
export async function openTabShare() {
  if (hasTabShare()) return;

  const controller = typeof CaptureController === 'function' ? new CaptureController() : undefined;
  /* 不要求 video 就不能要求 audio；畫面拿到就停掉，留下音訊。分頁照常從喇叭出聲。 */
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: PROCESSING_OFF,
    controller,
    selfBrowserSurface: 'exclude',   // 字幕頁自己的分頁只會聽到自己
    surfaceSwitching:   'include',   // 「改為共用這個分頁」，不用重開
    systemAudio:        'include',   // 選整個畫面時，Windows 可以帶系統音訊
    /* 選視窗時只帶那個程式的聲音（它所有的視窗），不是整個系統的。Discord 桌面版
       這類程式可以只聽它，不混進其他聲音。不支援的瀏覽器會忽略。
       即時翻譯 用媒體播放器在 Chrome 155・Edge（Windows）測過，2026-10-09。 */
    windowAudio:        'window',
  });
  /* 不然瀏覽器會把共用的分頁切到前面；使用者要看的是字幕。必須在拿到之後馬上呼叫。 */
  try { controller?.setFocusBehavior('no-focus-change'); } catch { /* 沒有焦點可言的共用類型 */ }
  stream.getVideoTracks().forEach(t => t.stop());

  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach(t => t.stop());
    throw new NoTabAudioError();
  }

  share = new MediaStream([track]);
  const current = share;
  /* 自己呼叫 stop() 不會觸發 ended，所以這裡只會聽到「使用者那邊結束了」。 */
  track.addEventListener('ended', () => {
    if (share !== current) return;
    share = null;
    log.warn('タブの共有が終了しました');
    notifyChange(false);
  });
  log.info('タブの共有を開始しました:', track.label);
  notifyChange(true);
}

/**
 * 共用中的分頁的複製。交給辨識引擎，它停止時 stop() 這份就好。
 * 沒在共用時丟出（呼叫端應該先 openTabShare）。
 */
export function cloneTabStream() {
  if (!hasTabShare()) throw new Error('タブを共有していません');
  return new MediaStream(share.getAudioTracks().map(t => t.clone()));
}

/** 結束共用（瀏覽器上方的「共用中」提示會消失）。 */
export function closeTabShare() {
  if (!share) return;
  share.getTracks().forEach(t => t.stop());
  share = null;
  log.info('タブの共有を終了しました');
  notifyChange(false);
}
