// config.js
// 目的：呼叫端可以傳語言 ID（如 'en-US'、'zh-TW'）或短碼（如 'en'、'id'），

import { Logger } from './logger.js';

let _config /** @type {LanguageConfig|null} */ = null;

let _isRayModeActive = false;
let _isForceSingleLine = false;
let _isDeepgramActive = false;

// ==========================================
// [新增] 瀏覽器環境偵測 (原本在 speechCapture.js)
// ==========================================
function detectBrowser() {
  // 為了安全起見，確保在瀏覽器環境執行
  if (typeof navigator === 'undefined') {
    return { browser: 'Unknown', isChrome: false, supportsTranslatorAPI: false };
  }

  const userAgent = navigator.userAgent || '';
  // userAgentData 是新標準，但為了相容性需做判斷
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) || [];

  // 偵測 Edge
  const isEdge = brands.some(b => /Edge|Microsoft\s?Edge/i.test(b)) || /Edg\//.test(userAgent);

  // 偵測 Chrome（排除 Edge）
  const isChrome = !isEdge && (brands.some(b => /Google Chrome/i.test(b)) || /Chrome\//.test(userAgent));

  let browser = 'Unknown';
  let supportsTranslatorAPI = false;

  if (isEdge) {
    browser = 'Edge';
  } else if (isChrome) {
    browser = 'Chrome';
    // 檢查 Translator API 是否存在於 window/self
    supportsTranslatorAPI = 'Translator' in self;
  } else {
    Logger.warn('[WARN] [config.js] 未檢測到 Chrome 或 Edge 瀏覽器:', userAgent);
  }

  return { browser, isChrome, supportsTranslatorAPI };
}

// 匯出 browserInfo 供其他模組使用
export const browserInfo = detectBrowser();

// ------------------------------
// 內部：共同小工具
// ------------------------------
function ensureLoaded() {
  if (!_config) throw new Error('[config.js] config 尚未載入，請先呼叫 loadLanguageConfig()');
}

function _getTargetCodeMap() /** @type {Record<string,string>} */ {
  ensureLoaded();
  return /** @type {LanguageConfig} */ (_config).targetCodeMap;
}

/** 以語言 ID 取得對應的語言條目；找不到回傳 null */
export function getLangById(id /** @type {string} */) /** @type {LanguageItem|null} */ {
  ensureLoaded();
  return /** @type {LanguageConfig} */ (_config).languages.find(l => l.id === id) || null;
}

/**
 * 將「ID 或短碼」正規化成「語言 ID」。
 * 1) 若傳入值本來就是 ID（可命中 languages[].id），直接回傳。
 * 2) 否則視為短碼，反查 targetCodeMap 的 value，找出對應的 ID。
 * 3) 若仍找不到，保留原字串（避免過度猜測）。
 */
function resolveLangId(idOrCode /** @type {string} */) /** @type {string} */ {
  ensureLoaded();
  if (getLangById(idOrCode)) return idOrCode; // 已是 ID
  const entry = Object.entries(_getTargetCodeMap()).find(([, code]) => code === idOrCode);
  return entry ? entry[0] : idOrCode;
}

// ------------------------------
// 對外：維持既有匯出 API 名稱
// ------------------------------

/** 從 URL 載入語言設定 JSON（預設為同目錄的 language_config.json） */
export async function loadLanguageConfig(url = './data/language_config.json') {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`[config.js] 載入失敗: ${res.status} ${res.statusText}`);
  const json = /** @type {LanguageConfig} */ (await res.json());
  if (!json || !Array.isArray(json.languages) || !json.targetCodeMap) {
    throw new Error('[config.js] 非法的語言設定物件');
  }
  _config = json;
  Logger.debug('[DEBUG] [config] 已載入語言設定，語言數量:', json.languages?.length ?? 0);
  return json;
}

/** 取得所有語言清單（原樣回傳設定檔的陣列） */
export function getAllLanguages() /** @type {LanguageItem[]} */ {
  ensureLoaded();
  return /** @type {LanguageConfig} */ (_config).languages;
}

/** 由語言 ID 取回短碼（若不存在回傳 null） */
export function getTargetCodeById(id /** @type {string} */) /** @type {string|null} */ {
  const code = _getTargetCodeMap()[id];
  return code ?? null;
}

/** 取得語言的 chunkSize（若無定義則回傳 null） */
export function getChunkSize(id /** @type {string} */) /** @type {number|null} */ {
  const lang = getLangById(id);
  return lang?.chunkSize ?? null;
}

/** 取得語言的 displayTimeRules（若無定義則回傳空陣列） */
export function getDisplayTimeRules(id /** @type {string} */) /** @type {Array<{maxLength:number,time:number}>} */ {
  const lang = getLangById(id);
  return lang?.displayTimeRules ?? [];
}

/**
 * 取得給 Translator API 使用的目標語言代碼。
 * - 會先把輸入正規化為語言 ID；
 * - 優先使用 targetCodeMap[ID]；若無，退而求其次用 languageModelApiCode；
 * - 仍無則回傳原輸入（不阻斷流程）。
 */
export function getTargetCodeForTranslator(idOrCode /** @type {string} */) /** @type {string} */ {
  ensureLoaded();
  const resolvedId = resolveLangId(idOrCode);
  const fromMap = _getTargetCodeMap()[resolvedId];
  if (fromMap) return fromMap;
  const lang = getLangById(resolvedId);
  return lang?.languageModelApiCode || idOrCode;
}

/**
 * 取得 Prompt API 要用的人類語名（promptApiCode）。
 * 可接受語言 ID（如 'en-US'）或短碼（如 'en'）皆可。
 * 找不到時回傳原輸入，並印出警告一次。
 */
export function getPromptApiCode(idOrCode /** @type {string} */) /** @type {string} */ {
  ensureLoaded();
  //Logger.debug('[DEBUG] [Config] getPromptApiCode 代碼:', { id: idOrCode });
  const resolvedId = resolveLangId(idOrCode);
  const lang = getLangById(resolvedId);
  if (!lang?.promptApiCode) {
    Logger.warn('[WARN] [Translation] 未找到 promptApiCode，使用輸入值:', { id: idOrCode });
    return idOrCode; // 保守退回原輸入，避免阻斷流程
  }
  return lang.promptApiCode;
}

/**
 * 取得模型要用的短碼（languageModelApiCode）。
 * 可接受語言 ID 或短碼。找不到時回傳原輸入，同時給出警告。
 */
export function getLanguageModelApiCode(idOrCode /** @type {string} */) /** @type {string} */ {
  ensureLoaded();
  const resolvedId = resolveLangId(idOrCode);
  const lang = getLangById(resolvedId);
  if (!lang?.languageModelApiCode) {
    Logger.warn('[WARN] [Translation] 未找到 languageModelApiCode，使用輸入值:', { id: idOrCode });
    return idOrCode;
  }
  return lang.languageModelApiCode;
}

// ==========================================
// Ray Mode 對外 函式
// ==========================================

/**
 * 取得目前 Ray Mode 是否開啟
 */
export function isRayModeActive() {
  return _isRayModeActive;
}

/**
 * 設定 Ray Mode 狀態
 * 供 uiController 在初始化或切換時呼叫
 */
export function setRayModeStatus(status) {
  _isRayModeActive = !!status;
}

// ==========================================
// 強制單行 對外 函式
// ==========================================

/**
 * 取得目前是否強制單行
 * 改為讀取內部變數
 */
export function isForceSingleLine() {
  return _isForceSingleLine;
}

/**
 * 設定強制單行狀態
 * 供 uiController 在初始化或切換時呼叫
 */
export function setForceSingleLineStatus(status) {
  _isForceSingleLine = !!status;
}

// ==========================================
// prompt api 對外 函式
// ==========================================

/**
 * 取得目前 prompt api 是否開啟
 * @returns {boolean}
 */
export function isPromptApiActive() {
  const modeSelect = document.getElementById('translation-mode');
  return modeSelect ? modeSelect.value === 'ai' : false;
}

// ==========================================
// translator api 對外 函式
// ==========================================

/**
 * 取得目前 translator api 是否開啟
 * @returns {boolean}
 */
export function isTranslationApiActive() {
  const modeSelect = document.getElementById('translation-mode');
  return modeSelect ? modeSelect.value === 'fast' : false;
}

// ==========================================
// Deepgram 對外 函式
// ==========================================

/**
 * 取得目前 Deepgram 是否開啟
 * 供 speechCapture.js 判斷使用
 */
export function isDeepgramActive() {
  return _isDeepgramActive;
}

/**
 * 設定 Deepgram 狀態
 * 供 uiController 在初始化或切換時呼叫
 * @param {boolean|string} status - true/'true' 為開啟
 */
export function setDeepgramStatus(status) {
  // 確保轉為布林值 (處理字串 'true'/'false')
  _isDeepgramActive = String(status) === 'true';
}

/**
 * [新增] 取得 Deepgram 專用的語言代碼
 * 使用 language_config.json 中的 targetCodeMap 進行轉換
 * 例如: 'ja-JP' -> 'ja', 'zh-TW' -> 'zh-TW'
 * 若無對應，則回傳原始 ID
 */
export function getDeepgramCode(id) {
  ensureLoaded();
  // 先嘗試從 targetCodeMap 找 (這通常是短碼，如 ja, en, ko)
  const code = _config.targetCodeMap[id];
  
  // 如果有找到就用 map 的值，沒找到就回傳原始 id (例如 zh-TW 在 map 裡可能就是 zh-TW)
  return code || id;
}

export async function getSourceLanguaage() {
  return document.getElementById('source-language')?.value;
}