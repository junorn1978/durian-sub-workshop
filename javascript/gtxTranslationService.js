/**
 * @file gtxTranslationService.js
 * @description Google 翻譯（非官方端點）翻譯模組。
 *
 * 端點：translate-pa.googleapis.com/v1/translateHtml
 *   Chrome 內建「翻譯這個網頁」走的非官方端點。POST + application/json+protobuf，
 *   需附 X-Goog-API-Key（Chrome 內嵌的公開常數，非帳號/機器綁定）。
 *   反應較快、限流門檻較寬。
 *
 * 注意：端點與 key 皆為非官方、未公開，Google 可能隨時調整或輪替。
 *       失敗時直接把錯誤拋給上層，由 translationController 顯示在 status-display。
 *       舊的 translate_a/single 端點不再作為自動退回（容易回 500，速度也明顯較慢）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 【如何更新 key】PA_API_KEY 失效（status-display 持續顯示 HTTP 403）時：
 *   1. 用 Chrome 開任一外文網頁，按右鍵「翻譯成中文」。
 *   2. F12 → Network 分頁，找對 translate-pa.googleapis.com/v1/translateHtml 的請求。
 *   3. 複製該請求 Request Headers 裡 x-goog-api-key 的值，取代下方 PA_API_KEY。
 *   ※ 這把 key 是 Chrome 內嵌的公開常數，全世界共用、不綁帳號或機器。
 *
 * 【遇到 400（請求格式錯誤）】把 PA_CLIENT_TAG 由 'te_lib' 改成 'wt_lib' 試。
 * ───────────────────────────────────────────────────────────────────────────
 */

import { isDebugEnabled } from './logger.js';
import { getLang } from './config.js';

// #region [常數]

/** translate-pa 端點 */
const PA_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml';

/** Chrome 內嵌的公開翻譯 key。失效（403）時的更新方式見檔頭【如何更新 key】。 */
const PA_API_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';

/** translateHtml 請求體尾端的用戶端識別字串。遇 400 時的處理見檔頭。 */
const PA_CLIENT_TAG = 'te_lib';

/** 單次請求逾時（毫秒） */
const REQUEST_TIMEOUT_MS = 10000;

// #endregion

// #region [共用工具]

/**
 * 具備超時中斷與 429 重試機制的 fetch 封裝。
 * 回傳原始 Response 物件，由呼叫端自行解析。
 * @async
 * @param {string} url
 * @param {Object} options
 * @param {number} retries
 * @param {number} delay
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timeoutId);

    if (response.status === 429 && retries > 0) {
      if (isDebugEnabled()) console.warn('[GTX] 偵測到 429 Too Many Requests，將在延遲後重試...', { retries, delay });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (retries > 0 && error.name !== 'AbortError') {
      if (isDebugEnabled()) console.warn('[GTX] 請求失敗，準備重試...', { error: error.message, retries });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * 語言代碼正規化。translate-pa 偏好 zh-TW / zh-CN 連字號格式。
 * @param {string} lang
 * @param {string} fallback - lang 為空時的預設值
 * @returns {string}
 */
function normalizeLang(lang, fallback) {
  let v = String(lang ?? '').trim() || fallback;
  if (v === 'zh_TW') v = 'zh-TW';
  if (v === 'zh_CN') v = 'zh-CN';
  return v;
}

/**
 * 解碼 HTML 實體。translateHtml 端點會把譯文當 HTML 回傳
 * （例如 & → &amp;、' → &#39;），需還原成純文字供字幕顯示。
 * @param {string} str
 * @returns {string}
 */
let _decoderEl = null;
function decodeHtmlEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  if (!_decoderEl) _decoderEl = document.createElement('textarea');
  _decoderEl.innerHTML = str;
  return _decoderEl.value;
}

/**
 * 獲取適用於 Google 翻譯的語言代碼
 * @param {string} langId
 * @returns {string}
 */
function getGTXCode(langId) {
  const langObj = getLang(langId);
  if (!langObj) return langId;
  return langObj.languageModelApiCode || langId;
}

// #endregion

// #region [端點實作]

/**
 * translate-pa（translateHtml）端點翻譯
 * @async
 * @param {string} text
 * @param {string} sl - 來源語言代碼
 * @param {string} tl - 目標語言代碼
 * @returns {Promise<string>} 譯文
 */
async function translateViaPa(text, sl, tl) {
  /* application/json+protobuf 格式：[[ [文字陣列], 來源語言, 目標語言 ], 用戶端標記] */
  const body = JSON.stringify([[[text], sl, tl], PA_CLIENT_TAG]);

  const resp = await fetchWithRetry(PA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'X-Goog-API-Key': PA_API_KEY,
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(`translate-pa HTTP ${resp.status}`);
  }

  const data = await resp.json();

  /* translateHtml 回傳：data[0] = 譯文陣列、data[1] = 偵測到的來源語言。此處一次只送一段。 */
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const raw = data[0].filter(s => typeof s === 'string').join('');
    return decodeHtmlEntities(raw);
  }
  return '';
}

// #endregion

/**
 * Google 翻譯實作。打 translate-pa 端點翻譯，失敗時直接拋出錯誤給上層處理。
 * @async
 * @param {string} text - 待翻譯文字
 * @param {Array<string>} targetLangs - 目標語言 ID 列表 (例如 ['zh-TW', 'en-US'])
 * @param {string} sourceLangId - 來源語言 ID (例如 'ja-JP')
 * @returns {Promise<Object|null>} 翻譯結果物件 { translations: [譯文1, 譯文2, ...] }
 * @throws {Error} translate-pa 端點呼叫失敗時拋出，由 translationController 顯示於 status-display。
 */
export async function translateWithGTX(text, targetLangs, sourceLangId) {
  if (!text || text.trim() === '') return null;

  const sl = normalizeLang(getGTXCode(sourceLangId), 'auto');

  const results = await Promise.all(targetLangs.map(async (tlId) => {
    if (!tlId || tlId === 'none') return '';
    const tl = normalizeLang(getGTXCode(tlId), 'zh-TW');
    return translateViaPa(text, sl, tl);
  }));

  return { translations: results };
}
