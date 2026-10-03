/**
 * @file sonioxPcmWorklet.js
 * @description Soniox 用的 AudioWorklet。把輸入轉成 pcm_s16le，累積到 bufferSize 再整塊送回主執行緒。
 * 多聲道輸入先平均成單聲道（Soniox 設定是 num_channels: 1）。
 */
class SonioxPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const bs = options?.processorOptions?.bufferSize;
    this.bufferSize = Number.isFinite(bs) ? bs : 1600;
    this.buffer = new Float32Array(this.bufferSize);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;

    const frameCount = input[0]?.length || 0;
    if (!frameCount) return true;

    const channelCount = input.length;

    for (let i = 0; i < frameCount; i++) {
      let sample = 0;
      for (let c = 0; c < channelCount; c++) {
        const data = input[c];
        if (data) sample += data[i];
      }
      if (channelCount > 1) sample /= channelCount;

      this.buffer[this.index++] = sample;
      if (this.index >= this.bufferSize) this.flush();
    }
    return true;
  }

  flush() {
    const int16 = new Int16Array(this.bufferSize);
    for (let i = 0; i < this.bufferSize; i++) {
      const s = this.buffer[i];
      const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
      int16[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    this.index = 0;
  }
}

registerProcessor('soniox-pcm-processor', SonioxPcmProcessor);
