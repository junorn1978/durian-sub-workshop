import { keywordRules } from './speechCapture.js';

// 佇列和處理狀態
let translationQueue = [];
let isProcessing = false;

// 在使用れいーモード的時候進行翻譯後的文字過濾
// 都會經過這裡，但模式是full的時候直接原文返回
function filterTextWithKeywords(text, targetLang) {
  const truncateMode = document.getElementById('text-truncate-mode')?.value || 'full';
  if (truncateMode === 'full') {return text};
  
  let result = text;
      result = result.replace(/"/g, ''); //過濾引號

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

// 處理佇列中的下一個請求
async function processQueue() {
  if (isProcessing || translationQueue.length === 0) return;

  isProcessing = true;
  const { text, sourceLang, browser } = translationQueue.shift();

  try {
    let serviceUrl = localStorage.getItem('api-key-input')?.trim();
    let serviceKey = '';

    if (!text || text.trim() === '' || text.trim() === 'っ') {
      console.debug('[DEBUG] [Translation] 無效文字，跳過翻譯:', text);
      return;
    }

    const targetLangs = [
      document.getElementById('target-language1')?.value,
      document.getElementById('target-language2')?.value,
      document.getElementById('target-language3')?.value
    ].filter(lang => lang && lang !== 'none');

    if (targetLangs.length === 0) {
      console.debug('[DEBUG] [Translation] 無目標語言，跳過翻譯');
      return;
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

    const data = await response.json();

    const spans = {
      target1: document.querySelector('.target-text-1'),
      target2: document.querySelector('.target-text-2'),
      target3: document.querySelector('.target-text-3')
    };

    const truncateMode = document.getElementById('text-truncate-mode')?.value || 'full';
    
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        targetLangs.forEach((lang, index) => {
          const span = spans[`target${index + 1}`];
          if (span && data.translations && data.translations[index]) {
            const filteredText = truncateMode === 'full' ? data.translations[index] :
                                 filterTextWithKeywords(data.translations[index], lang);
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

  } catch (error) {
    console.error('[ERROR] [Translation] 翻譯失敗:', error.message);
  } finally {
    isProcessing = false;
    processQueue(); // 處理下一個佇列中的請求
  }
}

// 修改後的 sendTranslationRequest 函數
async function sendTranslationRequest(text, sourceLang, browser) {
  translationQueue.push({ text, sourceLang, browser });
  console.debug('[DEBUG] [Translation] 加入佇列:', { text, sourceLang, browser });
  await processQueue();
}

export { sendTranslationRequest };