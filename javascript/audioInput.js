/**
 * @file audioInput.js
 * @description Web Speech API 用的麥克風輸入。
 *
 * 自己開麥克風，再用 recognition.start(track) 交給辨識器，不讓辨識器自己去開預設裝置。
 * 音訊握在自己手上之後才做得到：
 *   - 選擇裝置（deviceId 從這裡進來）
 *   - 之後在 AudioWorklet 裡判斷停頓、切 session 時扣住音訊再補送
 *
 * 目前只有直通：麥克風 → AudioContext → MediaStreamDestination 的音軌。
 * 經過 AudioContext 是為了 Edge：Edge 的辨識器只吃 16kHz 的音軌，48kHz 單聲道
 * 什麼都辨識不出來（即時翻譯 / hamham 實測，2026-09-27）。Chrome 用原生取樣率。
 *
 * 即時翻譯 實測（2026-09-28，虛擬音源線）：在已經開著的音軌上重啟 session，
 * abort() 之後約 20ms 就重新在聽；讓辨識器自己開麥克風則約 110ms。
 */

import { browserInfo } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('AudioInput');

/*
 * 瀏覽器端的前處理（回音消除・降噪・自動增益）。
 * 即時翻譯 那邊全部關掉：辨識器有自己的前端處理，原始訊號辨識得並沒有比較差。
 * 這裡先照做；要比對時改這一行。
 * （自動增益會把遠處的聲音也拉到聽得見的音量，見記憶 mic-far-voice-filtering）
 */
const INPUT_PROCESSING = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

const EDGE_SAMPLE_RATE = 16000;

/* 選定的裝置；裝置不見了（拔掉、改名）就退回預設裝置（fellBack）。權限錯誤不是裝置不見，直接往上丟。 */
async function openStream(deviceId) {
  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...INPUT_PROCESSING, deviceId: { exact: deviceId } }
      });
      return { stream, fellBack: false };
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: INPUT_PROCESSING });
  return { stream, fellBack: !!deviceId };
}

/**
 * 開麥克風並建好音訊路徑。
 * @param {object} [opts]
 * @param {string}   [opts.deviceId]  '' / undefined → 系統預設
 * @param {Function} [opts.onEnded]   裝置不見了（拔掉、停用）
 * @returns {Promise<{ track: MediaStreamTrack, label: string, deviceId: string, fellBack: boolean, close: Function }>}
 */
export async function openAudioInput({ deviceId = '', onEnded } = {}) {
  const { stream, fellBack } = await openStream(deviceId);
  const source = stream.getAudioTracks()[0];

  let ctx;
  let dest;
  try {
    ctx = new AudioContext(browserInfo.isChrome ? undefined : { sampleRate: EDGE_SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    ctx.createMediaStreamSource(stream).connect(dest);
  } catch (err) {
    ctx?.close();
    source.stop();
    throw err;
  }

  let closed = false;
  source.addEventListener('ended', () => { if (!closed) onEnded?.(); });

  const info = {
    label: source.label,
    deviceId: source.getSettings().deviceId || '',
    fellBack,
    sampleRate: ctx.sampleRate,
  };
  log.info('麥克風輸入已開啟', info);

  return {
    ...info,
    track: dest.stream.getAudioTracks()[0],
    close() {
      if (closed) return;
      closed = true;
      source.stop();
      dest.stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
