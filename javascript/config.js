// javascript/config.js
let _config = null;

async function loadLanguageConfig() {
  if (_config) return _config;
  const res = await fetch('data/language_config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('無法載入 language_config.json');
  _config = await res.json();
  return _config;
}

function getAllLanguages(role /* 'source' | 'target' */) {
  if (!_config) throw new Error('config 尚未載入');
  const list = _config.languages.filter(lang => {
    return role === 'source' ? lang.asSource : lang.asTarget;
  });
  return list;
}

function getLangById(id) {
  if (!_config) throw new Error('config 尚未載入');
  return _config.languages.find(l => l.id === id);
}

function getTargetCodeById(id) {
  if (!_config) throw new Error('config 尚未載入');
  return _config.targetCodeMap[id] || id;
}

function getChunkSize(id) {
  if (!_config) throw new Error('config 尚未載入');
  return (getLangById(id)?.chunkSize) ?? _config.defaults.chunkSize;
}

function getTargetCodeForTranslator(id) {
  if (!_config) throw new Error('config 尚未載入');
  const code = _config.targetCodeMap[id] || id;
  return code === 'zh-TW' ? 'zh-Hant' : code;
}

function getDisplayTimeRules(id) {
  if (!_config) throw new Error('config 尚未載入');
  return (getLangById(id)?.displayTimeRules) ?? _config.defaults.displayTimeRules;
}

function getPromptApiCode(id) {
  console.debug({id});
  if (!_config) throw new Error('config 尚未載入');
  const lang = getLangById(id);
  if (!lang?.promptApiCode) {
    console.warn('[WARN] [Translation] 未找到 promptApiCode，使用 targetCodeMap:', { id });
  }
  return lang?.promptApiCode || _config.targetCodeMap[id] || id;
}

function getLanguageModelApiCode(id) {
  if (!_config) throw new Error('config 尚未載入');
  const lang = getLangById(id);
  if (!lang?.languageModelApiCode) {
    console.warn('[WARN] [Translation] 未找到 languageModelApiCode，使用 targetCodeMap:', { id });
  }
  return lang?.languageModelApiCode || _config.targetCodeMap[id] || id;
}

export {
  loadLanguageConfig,
  getAllLanguages,
  getLangById,
  getTargetCodeById,
  getChunkSize,
  getDisplayTimeRules,
  getTargetCodeForTranslator,
  getPromptApiCode,
  getLanguageModelApiCode
};