/*
 * 從 即時翻譯 的 js/audio-worklet.js 原封不動複製過來（來源 commit b9131c4）。
 * 修改請在 即時翻譯 那邊做，再整個檔案覆蓋過來；這邊不要單獨改。
 * 裡面的 probe / gap / lag / level 訊息是那邊的診斷用，這邊的 audioInput.js 不接收。
 * 註解裡的 audio-input.js / speech.js 對應這邊的 audioInput.js / speechCapture.js。
 */
/**
 * @file audio-worklet.js
 * @description Audio-thread half of audio-input.js. Passes the microphone
 * through to the recogniser's track, and on the way:
 *
 *  - can hold the output (silence to the recogniser, real audio queued) and
 *    later release the queue;
 *  - catches up on what the queue costs in latency: plays it at SPEEDUP
 *    (WSOLA, pitch kept) and skips quiet stretches. Skipping alone is not
 *    enough — a speaker who never pauses leaves nothing to skip, and every
 *    session switch then adds another 0.5–0.8s for good (ported from the hamham
 *    extension, where 3 minutes of non-stop talk drifted from 0.23s to 1.89s
 *    behind with skipping only, and stayed at 0.13–0.21s with the speed-up);
 *  - detects pauses in what the recogniser is hearing, so speech.js can end a
 *    session where nobody is talking — judged on a denoised copy, so music in
 *    the background does not read as talking (see Denoiser).
 *
 * Pauses are detected on the output, not the microphone. The two differ by
 * whatever is still queued, and a pause in the room while the recogniser is
 * a second behind is, to the recogniser, the middle of a word: ending the
 * session there cut words in half (live stream test, 2026-09-28).
 *
 * Runs per 128-frame block on the audio thread, so none of it depends on
 * main-thread timers.
 */

/* Level tracking (ported from the hamham extension, tuned there on stream
   audio with background music): quiet is the level below whichever is higher
   — a fixed gate, or dropDb under the recent speech level. Both come in from
   audio-input.js, which the level test shares them with. The speech level
   follows speech with a time constant, not a per-block factor: a per-block
   factor sinks it to the music's level within ~0.1s, and then nothing is ever
   12dB below it. */
const LEVEL_SEC      = 0.05;   // RMS smoothing
const SPEECH_SEC     = 1.5;    // speech-level tracking

const PAUSE_SEC      = 0.35;   // quiet this long is a pause
const SHORT_SEC      = 0.15;   // …and this long a short one (a breath between phrases)
const HEARTBEAT_SEC  = 0.5;    // 'speech' repeats this often while talking
const GAP_REPORT_SEC = 0.1;    // quiet stretches from this long are reported (diagnostics)

/* Catch-up: a queued block is skipped only when it sits inside a quiet
   stretch at least this long, so gaps between syllables survive. */
const SKIP_QUIET_SEC = 0.1;
const QUEUE_SEC      = 10;     // past this the oldest audio is lost

/* More than TARGET_LAG_SEC queued: play at SPEEDUP until back within it.
   1.25 is what the hamham extension measured recognition to still cope with,
   fast-talking streamers included. */
const SPEEDUP        = 1.25;
const TARGET_LAG_SEC = 0.15;
/* WSOLA: 20ms frames at 50% overlap; each seam is placed where the waveform
   fits best within ±SEARCH_SEC. */
const FRAME_SEC      = 0.02;
const SEARCH_SEC     = 0.005;
const LAG_REPORT_SEC = 1;      // while queueing, the lag is reported this often (diagnostics)

const BLOCK = 128;

/* Smoothed level and how long it has been quiet. Used twice: on the input, to
   tag queued blocks for catch-up; on the output, for the pause events. */
class LevelTracker {
  constructor(blockSec, gateDb, dropDb) {
    this.blockSec   = blockSec;
    this.levelCoef  = 1 - Math.exp(-blockSec / LEVEL_SEC);
    this.speechCoef = 1 - Math.exp(-blockSec / SPEECH_SEC);
    this.gate       = 10 ** (gateDb / 20);
    this.drop       = 10 ** (-dropDb / 20);
    this.meanSquare = 0;
    this.speechLevel = 0.05;
    this.quietSec   = 0;
  }

  /* Returns true while the block counts as speech. */
  update(block) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += block[i] * block[i];
    return this.track(sum / BLOCK);
  }

  /* The same, from a block's mean square measured elsewhere (the denoiser). */
  track(meanSquare) {
    this.meanSquare += (meanSquare - this.meanSquare) * this.levelCoef;
    const rms = Math.sqrt(this.meanSquare);
    if (rms >= Math.max(this.gate, this.speechLevel * this.drop)) {
      this.speechLevel += (rms - this.speechLevel) * this.speechCoef;
      this.quietSec = 0;
      return true;
    }
    this.quietSec += this.blockSec;
    return false;
  }
}

/* ---- denoised level, for the pause detector only ----

   With background music the room never goes quiet: on a laptop microphone
   with BGM playing, speech measured only 2–3dB above the music, against the
   12dB a pause needs, and every session ran to the 20s cap. RNNoise strips
   the music from a copy of the signal and the level is read off that copy.
   What the recogniser hears is untouched — denoising tends to cost a robust
   recogniser accuracy rather than gain it, which is why the browser's own
   processing is off too (see audio-input.js).

   RNNoise (Xiph, BSD-3; wasm build by Jitsi, Apache-2.0 — js/vendor/) works
   on 10ms frames at 48kHz, in 16-bit sample scale. Other rates (Edge runs at
   16kHz) are interpolated up: the detector needs a level, not fidelity. The
   wasm is the bare emscripten build — its two imports are the heap-growth and
   big-memcpy helpers, and its exports are minified (names per the emscripten
   glue shipped with it). */
const RNN_RATE  = 48000;
const RNN_FRAME = 480;
const RNN_SCALE = 32768;

function instantiateRnnoise(bytes) {
  let memory;
  const imports = { a: {
    a: (requested) => {      // emscripten_resize_heap
      const grow = Math.ceil(((requested >>> 0) - memory.buffer.byteLength) / 65536);
      try { memory.grow(grow); return 1; } catch { return 0; }
    },
    b: (dest, src, num) => { new Uint8Array(memory.buffer).copyWithin(dest, src, src + num); },   // emscripten_memcpy_big
  } };
  const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports;
  memory = x.c;
  x.d();                     // static constructors
  return { memory, create: x.f, malloc: x.g, processFrame: x.j };
}

/* One RNNoise state: push a block, read the mean square of the latest
   denoised frame (in ±1 scale, like the blocks). Lags the input by a frame or
   two, ~20ms — nothing at the time scale of a pause. */
class Denoiser {
  constructor(rnn) {
    this.rnn   = rnn;
    this.state = rnn.create(0);
    this.inPtr  = rnn.malloc(RNN_FRAME * 4);
    this.outPtr = rnn.malloc(RNN_FRAME * 4);
    this.frame  = new Float32Array(RNN_FRAME);
    this.fill   = 0;
    this.step   = sampleRate / RNN_RATE;   // input samples per 48kHz sample
    this.pos    = 0;                       // read position within [prev, block]
    this.prev   = 0;                       // the previous block's last sample
    this.meanSquare = 0;
  }

  push(block) {
    /* Linear interpolation onto the 48kHz grid; pos runs from -1 (the
       previous block's last sample) to BLOCK - 1. At 48kHz it is a copy. */
    let pos = this.pos;
    while (pos <= BLOCK - 1) {
      const i = Math.floor(pos);
      const a = i < 0 ? this.prev : block[i];
      const b = block[i + 1] ?? a;
      this.frame[this.fill++] = (a + (b - a) * (pos - i)) * RNN_SCALE;
      if (this.fill === RNN_FRAME) this.process();
      pos += this.step;
    }
    this.pos  = pos - BLOCK;
    this.prev = block[BLOCK - 1];
    return this.meanSquare;
  }

  process() {
    this.fill = 0;
    const { memory, processFrame } = this.rnn;
    /* Views are made per frame: growing the heap replaces the buffer. */
    new Float32Array(memory.buffer, this.inPtr, RNN_FRAME).set(this.frame);
    processFrame(this.state, this.outPtr, this.inPtr);
    const out = new Float32Array(memory.buffer, this.outPtr, RNN_FRAME);
    let sum = 0;
    for (let i = 0; i < RNN_FRAME; i++) sum += out[i] * out[i];
    this.meanSquare = sum / RNN_FRAME / (RNN_SCALE * RNN_SCALE);
  }
}

class InputProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: { gateDb, dropDb, rnnoise, reportLevel } }) {
    super();
    const blockSec = BLOCK / sampleRate;
    this.blockSec = blockSec;
    this.inLevel  = new LevelTracker(blockSec, gateDb, dropDb);
    this.outLevel = new LevelTracker(blockSec, gateDb, dropDb);

    /* Input and output each get their own state: the two differ by whatever
       is queued, and RNNoise carries history from frame to frame. Without the
       wasm (not loaded, or turned off) the levels are read off the raw signal
       as before. */
    this.inDenoise = this.outDenoise = null;
    if (rnnoise) {
      try {
        const rnn = instantiateRnnoise(rnnoise);
        this.inDenoise  = new Denoiser(rnn);
        this.outDenoise = new Denoiser(rnn);
      } catch (err) {
        this.port.postMessage({ type: 'denoise', on: false, error: String(err) });
      }
    }
    if (this.inDenoise) this.port.postMessage({ type: 'denoise', on: true });

    /* Level test: the detector's input level, raw and as judged, ~25 times a
       second. */
    this.reportEvery = reportLevel ? Math.round(0.04 / blockSec) : 0;
    this.sinceReport = 0;
    this.rawSquare   = 0;
    this.paused    = true;
    this.shortSent = true;
    this.sinceBeat = 0;
    this.mono      = new Float32Array(BLOCK);
    this.holding   = false;

    /* Sample ring buffer. w / rd are running write / read positions in
       samples; each written block also records how long the input had been
       quiet, which is what catch-up skips by. */
    this.blocksCap = Math.ceil(QUEUE_SEC / blockSec);
    this.capacity  = this.blocksCap * BLOCK;
    this.samples   = new Float32Array(this.capacity);
    this.quietAt   = new Float32Array(this.blocksCap);
    this.w         = 0;
    this.rd        = 0;
    /* Once audio is queued, output comes from WSOLA until the queue is caught
       up and quiet; only then does it go back to passing straight through. */
    this.queueing  = false;

    /* WSOLA */
    this.hop      = Math.round(FRAME_SEC * sampleRate / 2);   // output samples per frame
    this.frameLen = this.hop * 2;
    this.search   = Math.round(SEARCH_SEC * sampleRate);
    this.window   = new Float32Array(this.frameLen);
    for (let i = 0; i < this.frameLen; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frameLen);   // sums to 1 at 50% overlap
    }
    this.ola     = new Float32Array(this.hop);                  // last frame's second half, awaiting the next
    this.outBuf  = new Float32Array(this.frameLen + BLOCK);     // synthesised, not yet sent
    this.outLen  = 0;
    this.prevPos = -1;   // where the last frame was read from; -1 = no continuity (start, skip, overflow)
    this.rdFrac  = 0;    // fractional read position while sped up
    this.sinceLagReport = 0;

    /* Audio the catch-up threw away rather than played: quiet stretches
       skipped while behind, a quiet queue dropped on catching up, and the
       oldest audio when the queue overflows. Running totals, for the probe. */
    this.skipped = 0;
    this.dropped = 0;
    this.probe   = null;

    this.port.onmessage = ({ data }) => {
      if (data === 'hold')    this.holding = true;
      if (data === 'release') this.holding = false;
      if (data?.probe)        this.startProbe(data.probe);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out   = outputs[0][0];
    const mono  = this.mono;

    mono.fill(0);
    if (input && input.length) {
      const k = 1 / input.length;
      for (const ch of input) for (let i = 0; i < BLOCK; i++) mono[i] += ch[i] * k;
    }
    if (this.inDenoise) this.inLevel.track(this.inDenoise.push(mono));
    else                this.inLevel.update(mono);
    this.reportLevel(mono);

    if (!this.holding && !this.queueing) {
      /* Fast path: nothing queued and nothing held — straight through. */
      out.set(mono);
      this.detect(out);
      this.probeBlock(out);
      return true;
    }

    this.queueing = true;
    this.enqueue(mono);
    this.reportLag();
    if (this.holding) {
      /* The recogniser hears nothing it should react to, and neither does
         the pause detector: its clock stops until the audio flows again. */
      out.fill(0);
      this.probeBlock(out);
      return true;
    }

    /* Caught up, and everything still queued is quiet (the room has been
       quiet longer than the queue is long): drop it and pass straight
       through again, at zero lag. */
    const lag = this.lagSec();
    if (lag < TARGET_LAG_SEC && this.inLevel.quietSec >= Math.max(SKIP_QUIET_SEC, lag + this.blockSec)) {
      this.resetQueue();
      out.set(mono);
    } else {
      this.render(out);
    }
    this.detect(out);
    this.probeBlock(out);
    return true;
  }

  lagSec() {
    return (this.w - this.rd) / sampleRate;
  }

  at(i) {
    return this.samples[i % this.capacity];
  }

  enqueue(block) {
    this.samples.set(block, this.w % this.capacity);
    this.quietAt[(this.w / BLOCK) % this.blocksCap] = this.inLevel.quietSec;
    this.w += BLOCK;
    if (this.w - this.rd > this.capacity - BLOCK) {
      /* Full: the oldest audio goes, and the seam there cannot be matched. */
      this.dropped += this.w - this.capacity + BLOCK - this.rd;
      this.rd = this.w - this.capacity + BLOCK;
      this.prevPos = -1;
    }
  }

  resetQueue() {
    this.dropped += this.w - this.rd;
    this.rd       = this.w;
    this.rdFrac   = 0;
    this.outLen   = 0;
    this.ola.fill(0);
    this.prevPos  = -1;
    this.queueing = false;
    this.sinceLagReport = 0;
    this.port.postMessage({ type: 'lag', sec: 0, rate: 1 });
  }

  isQuietAt(pos) {
    return this.quietAt[Math.floor(pos / BLOCK) % this.blocksCap] >= SKIP_QUIET_SEC;
  }

  /* One block of synthesised output; silence while there is not yet enough
     queued for a frame (just after queueing starts). */
  render(out) {
    while (this.outLen < BLOCK && this.synthFrame()) {}
    if (this.outLen < BLOCK) {
      out.fill(0);
      return;
    }
    out.set(this.outBuf.subarray(0, BLOCK));
    this.outBuf.copyWithin(0, BLOCK, this.outLen);
    this.outLen -= BLOCK;
  }

  /* Synthesises one frame (hop output samples). False when too little is queued. */
  synthFrame() {
    const hop  = this.hop;
    const need = this.frameLen + this.search * 2;
    if (this.w - this.rd < need) return false;

    const behind = this.lagSec() > TARGET_LAG_SEC;
    const rate   = behind ? SPEEDUP : 1;

    /* Behind: quiet stretches are skipped whole. */
    if (behind) {
      while (this.w - this.rd >= need + BLOCK && this.isQuietAt(this.rd) && this.isQuietAt(this.rd + BLOCK)) {
        this.rd += BLOCK;
        this.skipped += BLOCK;
        this.prevPos = -1;
      }
    }

    /* Sped up: pick the start within [rd, rd + 2*search] that best continues
       the last frame. At 1× it is always rd, and the overlapped Hann frames
       add back up to the original exactly. */
    let pos = this.rd;
    if (rate > 1 && this.prevPos >= 0) {
      const ref = this.prevPos + hop;
      let best = -Infinity;
      for (let k = 0; k <= this.search * 2; k += 2) {
        let c = 0;
        for (let i = 0; i < hop; i += 2) c += this.at(this.rd + k + i) * this.at(ref + i);
        if (c > best) { best = c; pos = this.rd + k; }
      }
    }

    const outBuf = this.outBuf;
    const win    = this.window;
    for (let i = 0; i < hop; i++) {
      outBuf[this.outLen + i] = this.ola[i] + this.at(pos + i) * win[i];
      this.ola[i] = this.at(pos + hop + i) * win[hop + i];
    }
    this.outLen += hop;
    this.prevPos = pos;

    const advance = hop * rate + this.rdFrac;
    const whole   = Math.floor(advance);
    this.rdFrac   = advance - whole;
    this.rd      += whole;
    return true;
  }

  reportLag() {
    this.sinceLagReport += this.blockSec;
    if (this.sinceLagReport < LAG_REPORT_SEC) return;
    this.sinceLagReport = 0;
    const sec = this.lagSec();
    this.port.postMessage({ type: 'lag', sec, rate: sec > TARGET_LAG_SEC ? SPEEDUP : 1 });
  }

  /* ---- probe (diagnostics) ----
     What the recogniser is actually fed, window by window: the output level
     as is, the detector's (denoised) view of it, and how much audio the
     catch-up threw away in the window. speech.js starts one at each session's
     onaudiostart and it runs until the next one replaces it, so a session
     fed speech that returned nothing shows as such end to end. Windows are
     fine-grained for the first `fineSec`, where the start-up questions are,
     and coarser after. */
  startProbe({ fineSec, fineMs, ms }) {
    this.probe = {
      fine:   Math.round(fineSec / this.blockSec),
      fineEvery: Math.max(1, Math.round(fineMs / 1000 / this.blockSec)),
      every:  Math.max(1, Math.round(ms / 1000 / this.blockSec)),
      n: 0, sum: 0, t: 0, held: 0,
      skipped: this.skipped,
      dropped: this.dropped,
    };
  }

  probeBlock(out) {
    const p = this.probe;
    if (!p) return;
    for (let i = 0; i < BLOCK; i++) p.sum += out[i] * out[i];
    if (this.holding) p.held++;
    p.n++;
    if (p.n < (p.t < p.fine ? p.fineEvery : p.every)) return;
    const toMs = (samples) => Math.round(samples / sampleRate * 1000);
    p.t += p.n;
    this.port.postMessage({
      type:     'probe',
      atMs:     Math.round(p.t * this.blockSec * 1000),
      outDb:    10 * Math.log10(p.sum / (p.n * BLOCK) + 1e-12),
      judgedDb: 10 * Math.log10(this.outLevel.meanSquare + 1e-12),
      speech:   this.outLevel.quietSec === 0,
      heldMs:   Math.round(p.held * this.blockSec * 1000),
      lagMs:    Math.round(this.lagSec() * 1000),
      skippedMs: toMs(this.skipped - p.skipped),
      droppedMs: toMs(this.dropped - p.dropped),
    });
    p.n = p.sum = p.held = 0;
    p.skipped = this.skipped;
    p.dropped = this.dropped;
  }

  /* Mean squares, smoothed like the detector's: raw over the same window, and
     the one the detector goes by (denoised, when it is on). */
  reportLevel(block) {
    if (!this.reportEvery) return;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += block[i] * block[i];
    this.rawSquare += (sum / BLOCK - this.rawSquare) * this.inLevel.levelCoef;
    if (++this.sinceReport < this.reportEvery) return;
    this.sinceReport = 0;
    this.port.postMessage({ type: 'level', raw: this.rawSquare, judged: this.inLevel.meanSquare });
  }

  detect(block) {
    const level = this.outLevel;
    const quietBefore = level.quietSec;
    const speech = this.outDenoise ? level.track(this.outDenoise.push(block)) : level.update(block);
    if (speech) {
      if (quietBefore >= GAP_REPORT_SEC) {
        this.port.postMessage({
          type: 'gap',
          ms: Math.round(quietBefore * 1000),
          queuedMs: Math.round(this.lagSec() * 1000),
        });
      }
      this.shortSent = false;
      this.sinceBeat += this.blockSec;
      if (this.paused || this.sinceBeat >= HEARTBEAT_SEC) {
        this.paused = false;
        this.sinceBeat = 0;
        this.port.postMessage({ type: 'speech' });
      }
      return;
    }
    if (!this.shortSent && level.quietSec >= SHORT_SEC) {
      this.shortSent = true;
      this.port.postMessage({ type: 'shortPause' });
    }
    if (!this.paused && level.quietSec >= PAUSE_SEC) {
      this.paused = true;
      this.port.postMessage({ type: 'pause' });
    }
  }
}

registerProcessor('speech-input', InputProcessor);
