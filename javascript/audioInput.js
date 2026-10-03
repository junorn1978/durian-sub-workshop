/**
 * @file audioInput.js
 * @description Web Speech API 用的麥克風輸入。
 *
 * 自己開麥克風，再用 recognition.start(track) 交給辨識器，不讓辨識器自己去開預設裝置。
 * 音訊握在自己手上之後才做得到：
 *   - 選擇裝置（deviceId 從這裡進來）
 *   - 知道講者什麼時候停頓（不靠辨識器），讓 session 在不會掉字的地方結束
 *   - 切 session 時先扣住音訊、之後再補送，讓重啟的空檔不掉字
 *
 * 路徑：麥克風 → AudioWorklet（speechInputWorklet.js）→ MediaStreamDestination 的音軌。
 * 經過 AudioContext 也是為了 Edge：Edge 的辨識器只吃 16kHz 的音軌，48kHz 單聲道
 * 什麼都辨識不出來（即時翻譯 / hamham 實測，2026-09-27）。Chrome 用原生取樣率。
 *
 * 這一層與 worklet 都是從 即時翻譯 的 audio-input.js 移植過來，參數與實測依據都在那邊。
 * 這邊的 Web Speech API 是備案，所以只搬了辨識用得到的部分，沒有音量測試與診斷。
 */

import { browserInfo } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('AudioInput');

const WORKLET_URL = new URL('./speechInputWorklet.js', import.meta.url);

/* 停頓判斷的門檻（見 speechInputWorklet.js）：比講話音量低 PAUSE_DROP_DB 以上、
   而且不超過 PAUSE_GATE_DB 才算安靜。 */
const PAUSE_GATE_DB = -50;
const PAUSE_DROP_DB = 12;

/*
 * 瀏覽器端的前處理（回音消除・降噪・自動增益）。
 * 即時翻譯 那邊全部關掉：辨識器有自己的前端處理，原始訊號辨識得並沒有比較差。
 * 這裡先照做；要比對時改這一行。
 * （自動增益會把遠處的聲音也拉到聽得見的音量，見記憶 mic-far-voice-filtering）
 */
const INPUT_PROCESSING = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

const EDGE_SAMPLE_RATE = 16000;

/* 停頓判斷用的降噪（RNNoise）。只用在判斷停頓的那份訊號上，辨識器聽到的音訊不經過它。
   沒有它的話，背景音樂讓房間永遠不安靜，session 每次都拖到上限才切。
   載入失敗時退回用原始音量判斷。 */
const RNNOISE_URL = new URL('./vendor/rnnoise.wasm', import.meta.url);
let rnnoiseBytes = null;

function loadRnnoise() {
  rnnoiseBytes ??= fetch(RNNOISE_URL)
    .then(r => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null)
    .then((bytes) => { if (!bytes) rnnoiseBytes = null; return bytes; });   // 失敗的話下次再試
  return rnnoiseBytes;
}

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
 * @param {string}   [opts.deviceId]     '' / undefined → 系統預設
 * @param {Function} [opts.onPause]      辨識器聽到的聲音安靜下來了（350ms）
 * @param {Function} [opts.onShortPause] 短暫安靜（150ms，換氣）
 * @param {Function} [opts.onSpeech]     正在講話（講話期間每 0.5 秒重複）
 * @param {Function} [opts.onEnded]      裝置不見了（拔掉、停用）
 * @returns {Promise<{ track: MediaStreamTrack, label: string, deviceId: string, fellBack: boolean,
 *   hold: Function, release: Function, close: Function }>}
 */
export async function openAudioInput({ deviceId = '', onPause, onShortPause, onSpeech, onEnded } = {}) {
  const { stream, fellBack } = await openStream(deviceId);
  const source = stream.getAudioTracks()[0];

  let ctx;
  let node;
  let dest;
  try {
    ctx = new AudioContext(browserInfo.isChrome ? undefined : { sampleRate: EDGE_SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    const [rnnoise] = await Promise.all([loadRnnoise(), ctx.audioWorklet.addModule(WORKLET_URL)]);
    node = new AudioWorkletNode(ctx, 'speech-input', {
      outputChannelCount: [1],
      processorOptions: { gateDb: PAUSE_GATE_DB, dropDb: PAUSE_DROP_DB, rnnoise, reportLevel: false },
    });
    dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    ctx.createMediaStreamSource(stream).connect(node).connect(dest);
  } catch (err) {
    ctx?.close();
    source.stop();
    throw err;
  }

  node.port.onmessage = ({ data }) => {
    if (data.type === 'pause')      onPause?.();
    if (data.type === 'shortPause') onShortPause?.();
    if (data.type === 'speech')     onSpeech?.();
    if (data.type === 'denoise' && !data.on) log.warn('停頓判斷的降噪無法使用，改用原始音量判斷:', data.error);
  };

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
    track:   dest.stream.getAudioTracks()[0],
    hold:    () => node.port.postMessage('hold'),
    release: () => node.port.postMessage('release'),
    close() {
      if (closed) return;
      closed = true;
      node.port.onmessage = null;
      source.stop();
      dest.stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
