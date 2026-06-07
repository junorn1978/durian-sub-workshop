/**
 * @file rayModeFilter.js
 * @description Ray Mode 關鍵字規則的載入、快取與文字過濾。
 * 統一管理來源端（辨識文字）與目標端（翻譯結果）的過濾邏輯。
 */

import { isRayModeActive } from './config.js';
import { isDebugEnabled } from './logger.js';

// #region [狀態與快取]

/** @type {Array<Object>} Ray Mode 關鍵字規則集 */
let keywordRules = [];

/** @type {Map<string, Object>} 以語言為 Key 的正規表達式規則快取（來源端） */
const cachedRules = new Map();

/** @type {Map<string, Array<Object>>} 以語言為 Key 的正規表達式規則快取（目標端） */
const keywordRuleCache = new Map();

// #endregion

// #region [規則載入]

/** 異步載入 Ray Mode 字詞轉換規則 */
async function loadKeywordRules() {
  const response = await fetch('data/ray_mode_keywords.json');
  if (!response.ok) throw new Error('無法載入關鍵字規則');

  keywordRules = await response.json();
  const uniqueLangs = [...new Set(keywordRules.map(r => r.lang))];

  uniqueLangs.forEach(lang => {
    const rulesForLang = keywordRules
      .filter(r => r.lang === lang)
      .map(r => ({
        sourcePattern: r.source,   // 仍然是「regex pattern 字串」
        target: r.target
      }))
      // 最長優先：避免短詞先吃掉長詞
      .sort((a, b) => b.sourcePattern.length - a.sourcePattern.length);

    // 預編譯：精準判斷是哪一條規則命中（避免每次都new RegExp）
    const compiledRules = rulesForLang.map(r => ({
      target: r.target,
      exact: new RegExp(`^(?:${r.sourcePattern})$`, 'i') // 不要 g，避免 lastIndex 問題
    }));

    // 預編譯：一次掃描用的 master regex
    const pattern = rulesForLang.map(r => `(?:${r.sourcePattern})`).join('|');
    const master = pattern ? new RegExp(pattern, 'ig') : null;

    cachedRules.set(lang, { rules: compiledRules, master });
  });
}

// #endregion

// #region [來源端過濾]

/**
 * 在 Ray mode 時進行的逐字稿文字替換處理（Web Speech API final transcript 用）
 * @param {string} text
 * @param {string} sourceLang
 * @returns {string} 清理後的文字
 */
function filterRayModeText(text, sourceLang) {
  if (!text || text.trim() === '' || text.trim() === 'っ' || text.trim() === 'っ。') {
    return '';
  }

  let result = text.replace(/[、。？,.]/g, ' ');

  const pack = cachedRules.get(sourceLang) || [];

  if (!pack || !pack.master) {
    return result;
  }

  const { rules, master } = pack;

  try {
    result = result.replace(master, (match) => {
      const hit = rules.find(r => r.exact.test(match));
      return hit ? hit.target : match;
    });
  } catch (e) {
    if (isDebugEnabled()) console.error('[ERROR] filterRayModeText 替換失敗:', e);
  }

  return result;
}

/** 在 Ray Mode 時發送翻譯會經過這邊先替換語句（Deepgram + 顯示用） */
function processRayModeTranscript(text, sourceLang) {
  if (!text || !text.trim() || ['っ', 'っ。', '。', '？'].includes(text.trim())) return '';
  const pack = cachedRules.get(sourceLang);
  if (!pack || !pack.master) return text;

  const { rules, master } = pack;

  try {
    return text.replace(master, (match) => {
      const hit = rules.find(r => r.exact.test(match));
      return hit ? hit.target : match;
    });
  } catch (e) {
    let result = text;
    return result;
  }
}

// #endregion

// #region [目標端過濾]

/**
 * 針對翻譯後的結果進行 Ray Mode 關鍵字過濾
 * @param {string} text
 * @param {string} targetLangId - 傳入目標語言 ID
 */
function filterTextWithKeywords(text, targetLangId) {
  if (!isRayModeActive()) return text;

  let result = text.replace(/"/g, '');

  if (!keywordRuleCache.has(targetLangId)) {
    keywordRuleCache.set(targetLangId, keywordRules
      .filter(rule => rule.lang === targetLangId)
      .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
  }
  keywordRuleCache.get(targetLangId)?.forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });
  return result;
}

// #endregion

export { loadKeywordRules, filterRayModeText, processRayModeTranscript, filterTextWithKeywords };
