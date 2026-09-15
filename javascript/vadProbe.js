/**
 * @file vadProbe.js
 * @description 本地 VAD（音量門檻斷句）的「只觀測」版。
 *
 * 目的：在完全不改變現有行為的前提下，量出三件事，用來判斷手動強制結算
 * （Soniox 的 {"type":"finalize"}）值不值得做：
 *   1. 這個環境的底噪長什麼樣 —— 音量門檻定不定得起來
 *   2. 用靜音門檻切句，一分鐘會切幾次 —— 會不會踩到官方「間隔數秒」的限制
 *   3. VAD 察覺「話講完了」比 Soniox 的 <end> 早多少 —— 值不值得換
 *
 * 這裡只計算與記錄，不會送出 finalize，也不會碰字幕或翻譯。
 * 三個靜音門檻同時模擬，一場就能拿到三組數據。
 *
 * 觀測結束後整支刪掉，連同 sonioxService.js 裡的三個呼叫點。
 */

import { createLogger } from "./logger.js";

const log = createLogger('VADProbe');

// 同時模擬的靜音門檻。官方建議「語音結束後約 200ms 靜音再呼叫 finalize」，
// 這裡從 400ms 起跳留一點餘裕。
const SILENCE_THRESHOLDS_MS = [400, 600, 800];
// 領先時間拿哪一個門檻去跟 <end> 比。
const PRIMARY_THRESHOLD_MS = 600;

// 官方警告呼叫過密會斷線，所以模擬時也套上節流，看看會擋掉多少。
const MIN_FINALIZE_INTERVAL_MS = 2500;

// 門檻 = max(底噪 × NOISE_MULT, ABS_FLOOR_RMS)。
// ABS_FLOOR_RMS 是給「底噪等於 0」的情境用的保底值（虛擬音源常常是數位全靜音，
// 這時 底噪×倍數 會變成 0，門檻等於失效）。0.003 RMS ≈ -50 dBFS。
const NOISE_MULT = 3.5;
const ABS_FLOOR_RMS = 0.003;

// 底噪估計：每秒取一個最小值，再取最近 N 秒的最小值。
const NOISE_BUCKET_MS = 1000;
const NOISE_WINDOW_SEC = 10;

// 每累積這麼多音訊就印一次中途摘要。
const HEARTBEAT_MS = 30000;

// dBFS 樣本的保存上限，避免長時間直播把記憶體吃掉（100ms 一格 ≈ 3.3 小時）。
const MAX_SAMPLES = 120000;

let active = false;
let audioMs = 0;
let heartbeatAt = 0;

let dbfsSamples = [];
let bucketMin = Infinity;
let bucketElapsed = 0;
let noiseBuckets = [];

let trackers = [];
let lastPrimaryTriggerAt = 0;

let endpointCount = 0;
let leadTimes = [];         // <end> 比模擬觸發晚了多少 ms
let endpointWithoutVad = 0; // 附近找不到模擬觸發的 <end>

function toDbfs(rms) {
  if (!(rms > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(rms));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function median(values) {
  if (values.length === 0) return NaN;
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function currentNoiseFloor() {
  if (noiseBuckets.length > 0) return Math.min(...noiseBuckets);
  return Number.isFinite(bucketMin) ? bucketMin : 0;
}

function currentThreshold() {
  return Math.max(currentNoiseFloor() * NOISE_MULT, ABS_FLOOR_RMS);
}

/** 開始觀測。startSoniox 建立音訊管線後呼叫。 */
export function resetVadProbe() {
  active = true;
  audioMs = 0;
  heartbeatAt = 0;
  dbfsSamples = [];
  bucketMin = Infinity;
  bucketElapsed = 0;
  noiseBuckets = [];
  lastPrimaryTriggerAt = 0;
  endpointCount = 0;
  leadTimes = [];
  endpointWithoutVad = 0;

  trackers = SILENCE_THRESHOLDS_MS.map(ms => ({
    ms,
    silenceMs: 0,
    armed: false,   // 上次觸發之後有沒有再聽到聲音（避免長靜音重複觸發）
    fired: false,   // 這一段靜音是否已經判定過
    accepted: 0,
    blockedByThrottle: 0,
    blockedByNoText: 0,
    lastAcceptedAt: 0,
    intervals: []
  }));

  log.info("VAD 觀測開始", {
    門檻: SILENCE_THRESHOLDS_MS,
    節流: MIN_FINALIZE_INTERVAL_MS,
    底噪倍數: NOISE_MULT,
    保底門檻dBFS: round(toDbfs(ABS_FLOOR_RMS))
  });
}

/**
 * 每個音訊區塊呼叫一次（約 100ms）。
 * @param {number} rms      該區塊的 RMS（Float32 音訊，0～1）
 * @param {number} frameMs  該區塊代表的音訊長度
 * @param {boolean} hasText 目前緩衝區有沒有待處理的文字（沒有就不該送 finalize）
 */
export function feedVadProbe(rms, frameMs, hasText) {
  if (!active || !Number.isFinite(rms) || !Number.isFinite(frameMs)) return;

  const now = Date.now();
  audioMs += frameMs;

  if (dbfsSamples.length < MAX_SAMPLES) dbfsSamples.push(toDbfs(rms));

  // 底噪估計
  bucketMin = Math.min(bucketMin, rms);
  bucketElapsed += frameMs;
  if (bucketElapsed >= NOISE_BUCKET_MS) {
    noiseBuckets.push(bucketMin);
    if (noiseBuckets.length > NOISE_WINDOW_SEC) noiseBuckets.shift();
    bucketMin = Infinity;
    bucketElapsed = 0;
  }

  const threshold = currentThreshold();
  const isSpeech = rms >= threshold;

  for (const t of trackers) {
    if (isSpeech) {
      t.silenceMs = 0;
      t.armed = true;
      t.fired = false;
      continue;
    }

    t.silenceMs += frameMs;
    if (t.fired || !t.armed || t.silenceMs < t.ms) continue;
    t.fired = true;

    // 這裡就是「如果真的做，會在這一刻送出 finalize」的點
    if (!hasText) { t.blockedByNoText++; continue; }
    if (t.lastAcceptedAt && now - t.lastAcceptedAt < MIN_FINALIZE_INTERVAL_MS) {
      t.blockedByThrottle++;
      continue;
    }

    if (t.lastAcceptedAt) t.intervals.push(now - t.lastAcceptedAt);
    t.lastAcceptedAt = now;
    t.accepted++;
    t.armed = false;

    if (t.ms === PRIMARY_THRESHOLD_MS) {
      lastPrimaryTriggerAt = now;
      log.debug("模擬斷句", { 門檻: t.ms, 第幾次: t.accepted });
    }
  }

  if (audioMs - heartbeatAt >= HEARTBEAT_MS) {
    heartbeatAt = audioMs;
    log.info("VAD 中途", {
      音訊分: round(audioMs / 60000, 1),
      底噪dBFS: round(toDbfs(currentNoiseFloor())),
      門檻dBFS: round(toDbfs(threshold)),
      模擬觸發: trackers.map(t => `${t.ms}ms:${t.accepted}`).join(" "),
      端點: endpointCount
    });
  }
}

/** Soniox 送來 <end> 時呼叫，用來比對領先時間。 */
export function noteVadEndpoint() {
  if (!active) return;
  endpointCount++;
  const now = Date.now();
  if (lastPrimaryTriggerAt && now - lastPrimaryTriggerAt <= 5000) {
    leadTimes.push(now - lastPrimaryTriggerAt);
  } else {
    endpointWithoutVad++;
  }
}

/** 印出總結。停止服務時呼叫，也可以在 console 手動叫 __vadProbe()。 */
export function reportVadProbe(tag = "停止時") {
  if (!active && audioMs === 0) return;

  const minutes = audioMs / 60000;
  const sorted = [...dbfsSamples].sort((a, b) => a - b);
  const floor = currentNoiseFloor();
  const threshold = currentThreshold();
  const floorIsSilent = floor * NOISE_MULT < ABS_FLOOR_RMS;

  log.info(`===== VAD 觀測結果（${tag}）=====`);
  log.info("時間", {
    音訊分鐘: round(minutes, 2),
    區塊數: dbfsSamples.length
  });
  log.info("音量分佈dBFS", {
    p5: round(percentile(sorted, 0.05)),
    p25: round(percentile(sorted, 0.25)),
    p50: round(percentile(sorted, 0.50)),
    p75: round(percentile(sorted, 0.75)),
    p95: round(percentile(sorted, 0.95))
  });
  log.info("門檻", {
    底噪dBFS: round(toDbfs(floor)),
    實際門檻dBFS: round(toDbfs(threshold)),
    來源: floorIsSilent ? "保底值（底噪太低，倍數法失效）" : "底噪×倍數"
  });

  if (floorIsSilent) {
    log.warn(
      "底噪接近數位全靜音，這是虛擬音源的特徵。真實麥克風不會這樣，" +
      "所以「門檻」那組數字不能直接套到實機。但下面的「觸發頻率」和" +
      "「領先時間」仍然有參考價值。"
    );
  }

  for (const t of trackers) {
    log.info(`靜音門檻 ${t.ms}ms`, {
      模擬斷句次數: t.accepted,
      每分鐘: round(minutes > 0 ? t.accepted / minutes : 0),
      中位間隔ms: round(median(t.intervals), 0),
      最短間隔ms: t.intervals.length ? round(Math.min(...t.intervals), 0) : null,
      被節流擋掉: t.blockedByThrottle,
      無文字略過: t.blockedByNoText
    });
  }

  log.info("Soniox 端點", {
    次數: endpointCount,
    每分鐘: round(minutes > 0 ? endpointCount / minutes : 0),
    VAD領先中位ms: round(median(leadTimes), 0),
    VAD領先樣本數: leadTimes.length,
    附近無VAD觸發: endpointWithoutVad
  });

  const primary = trackers.find(t => t.ms === PRIMARY_THRESHOLD_MS);
  const medInterval = primary ? median(primary.intervals) : NaN;
  const medLead = median(leadTimes);
  const verdict = [];
  if (Number.isFinite(medInterval) && medInterval < MIN_FINALIZE_INTERVAL_MS) {
    verdict.push(`中位間隔 ${round(medInterval, 0)}ms 短於節流 ${MIN_FINALIZE_INTERVAL_MS}ms，多數斷句會被擋掉`);
  }
  if (Number.isFinite(medLead) && medLead < 200) {
    verdict.push(`比 <end> 只早 ${round(medLead, 0)}ms，不足以抵掉準確度的代價`);
  }
  if (primary && primary.blockedByThrottle > primary.accepted) {
    verdict.push("被節流擋掉的次數多於成功次數");
  }
  log.info("判讀", verdict.length ? verdict : ["沒有明顯的否決訊號，值得往下做"]);
  log.info("================================");
}

// console 手動撈用，不想等停止服務才看。
if (typeof window !== "undefined") {
  window.__vadProbe = () => reportVadProbe("手動");
}
