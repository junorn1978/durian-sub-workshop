import { keywordRules } from './speechCapture_temp.js';

const bcp47ToLanguageName = {
  "zh-TW": "繁體中文",
  "ja-JP": "日本語",
  "en-US": "English",
  "es-ES": "Spanish",
  "id-ID": "Indonesian",
  "th-TH": "Thai",
  "vi-VN": "Vietnamese"
};

// 佇列和處理狀態
let translationQueue = [];
let isProcessing = false;

// 在使用れいーモード的時候進行翻譯後的文字過濾
function filterTextWithKeywords(text, targetLang) {
  const rayModeButton = document.getElementById('raymode');
  const isRayModeActive = rayModeButton?.classList.contains('active') || false;
  if (!isRayModeActive) return text;

  let result = text;
  result = result.replace(/"/g, ''); // 過濾引號

  const cachedRules = new Map();
  if (!cachedRules.has(targetLang)) {
    cachedRules.set(targetLang, keywordRules
      .filter(rule => rule.lang === targetLang)
      .map(rule => ({ source: new RegExp(rule.source, 'ig'), target: rule.target })));
  }
  cachedRules.get(targetLang).forEach(rule => {
    result = result.replace(rule.source, rule.target);
  });
  return result;
}

// 發送翻譯請求的核心邏輯
async function sendTranslation(text, targetLangs, serviceUrl, serviceKey) {
  if (!text || text.trim() === '' || text.trim() === 'っ') {
    console.debug('[DEBUG] [Translation] 無效文字，跳過翻譯:', text);
    return null;
  }

  if (!serviceUrl) throw new Error('Service URL is empty.');

  // 解析 protocol://domain 格式，允許開頭空格
  const urlPattern = /^\s*(\w+):\/\/(.+)$/;
  const match = serviceUrl.match(urlPattern);
  if (match) {
    const protocol = match[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') {
      serviceKey = match[1];
      serviceUrl = match[2];
      localStorage.setItem('api-key-value', serviceKey);
    } else {
      serviceUrl = match[2];
    }
  }

  // 拼接 https:// 和 /translate
  serviceUrl = `https://${serviceUrl}/translate`;

  // 驗證最終 URL 格式
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?\/translate$/.test(serviceUrl)) {
    throw new Error('Invalid URL format.');
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  if (serviceKey) headers['X-API-Key'] = serviceKey;

  const payload = {
    text,
    targetLangs
  };

  console.debug('[DEBUG] [Translation] 發送翻譯請求:', { text, targetLangs });

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}

// 更新 UI 的邏輯
async function updateTranslationUI(data, targetLangs) {
  const spans = {
    target1: document.getElementById('target-text-1'),
    target2: document.getElementById('target-text-2'),
    target3: document.getElementById('target-text-3')
  };

  const rayModeButton = document.getElementById('raymode');
  const isRayModeActive = rayModeButton?.classList.contains('active') || false;

  await new Promise(resolve => {
    requestAnimationFrame(() => {
      targetLangs.forEach((lang, index) => {
        const span = spans[`target${index + 1}`];
        if (span && data.translations && data.translations[index]) {
          const filteredText = isRayModeActive ? filterTextWithKeywords(data.translations[index], lang) : data.translations[index];
          span.textContent = filteredText;
          span.dataset.stroke = filteredText;
          span.style.display = 'inline-block';
          span.offsetHeight;
          span.style.display = '';
          console.info('[INFO] [Translation] 更新翻譯文字:', { lang, text: data.translations[index] });
        }
      });
      resolve();
    });
  });
}

// 處理佇列中的下一個請求
async function processQueue() {
  if (isProcessing || translationQueue.length === 0) return;

  isProcessing = true;
  const { text, sourceLang, browser } = translationQueue.shift();

  try {
    const serviceUrl = document.getElementById('translation-link').value;
    let serviceKey = '';

    const targetLangsBcp47 = [
      document.getElementById('target1-language')?.value,
      document.getElementById('target2-language')?.value,
      document.getElementById('target3-language')?.value
    ].filter(lang => lang && lang !== 'none');

    if (targetLangsBcp47.length === 0) {
      console.debug('[DEBUG] [Translation] 無目標語言，跳過翻譯');
      return;
    }

    const targetLangs = targetLangsBcp47.map(lang => {
      const langName = bcp47ToLanguageName[lang] || lang.split('-')[0];
      console.debug('[DEBUG] [Translation] 語言轉換: ${lang} -> ${langName}');
      return langName;
    });

    const data = await sendTranslation(text, targetLangs, serviceUrl, serviceKey);
    if (data) {
      await updateTranslationUI(data, targetLangs);
    }
  } catch (error) {
    console.error('[ERROR] [Translation] 翻譯失敗:', error.message);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// 公開的翻譯請求函數
async function sendTranslationRequest(text, sourceLang, browser) {
  translationQueue.push({ text, sourceLang, browser });
  console.debug('[DEBUG] [Translation] 加入佇列:', { text, sourceLang, browser });
  await processQueue();
}

export { sendTranslationRequest, sendTranslation, bcp47ToLanguageName };