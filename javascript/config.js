// config.js
// 目的：呼叫端可以傳語言 ID（如 'en-US'、'zh-TW'）或短碼（如 'en'、'id'），

/** @typedef {{
 *  id: string,
 *  label: string,
 *  asSource?: boolean,
 *  asTarget?: boolean,
 *  chunkSize?: number,
 *  displayTimeRules?: Array<{maxLength:number,time:number}>,
 *  commentLangCode?: string,
 *  promptApiCode?: string,        // 給 Prompt 用的人類語名（例如 'English', '台灣國語'）
 *  languageModelApiCode?: string  // 給模型用的短碼（例如 'en', 'id', 'zh-hant'）
 * }} LanguageItem */

/** @typedef {{
 *  languages: LanguageItem[],
 *  targetCodeMap: Record<string,string> // key: 語言 ID（如 'en-US'），value: 短碼（如 'en'）
 * }} LanguageConfig */

let _config /** @type {LanguageConfig|null} */ = null;

let _isRayModeActive = false;
let _isForceSingleLine = false;

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
  console.debug('[DEBUG] [config] 已載入語言設定，語言數量:', json.languages?.length ?? 0);
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
  //console.debug('[DEBUG] [Config] getPromptApiCode 代碼:', { id: idOrCode });
  const resolvedId = resolveLangId(idOrCode);
  const lang = getLangById(resolvedId);
  if (!lang?.promptApiCode) {
    console.warn('[WARN] [Translation] 未找到 promptApiCode，使用輸入值:', { id: idOrCode });
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
    console.warn('[WARN] [Translation] 未找到 languageModelApiCode，使用輸入值:', { id: idOrCode });
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
