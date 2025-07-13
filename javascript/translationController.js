// translationController.js

async function sendTranslationRequest(text, sourceLang, browser) {
  const serviceUrl = localStorage.getItem('api-key-input')?.trim();
  const apiKey = localStorage.getItem('api-key-value')?.trim();

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

  try {
    if (!serviceUrl) throw new Error('Service URL is empty.');
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?\/.+$/.test(serviceUrl)) {
      throw new Error('Invalid URL format.');
    }

    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) headers['X-API-Key'] = apiKey;

    const payload = {
      text,
      targetLangs
    };

    console.debug('[DEBUG] [Translation] 發送翻譯請求:', { url: serviceUrl, payload });

    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`翻譯請求失敗: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();
    // console.info('[INFO] [Translation] 翻譯結果:', data);

    const spans = {
      target1: document.querySelector('.target-text-1'),
      target2: document.querySelector('.target-text-2'),
      target3: document.querySelector('.target-text-3')
    };

    targetLangs.forEach((lang, index) => {
      const span = spans[`target${index + 1}`];
      if (span && data.translations && data.translations[index]) {
        requestAnimationFrame(() => {
          span.textContent = data.translations[index];
          span.dataset.stroke = data.translations[index];
          span.style.display = 'inline-block';
          span.offsetHeight;
          span.style.display = '';
          console.info('[INFO] [Translation] 更新翻譯文字:', { lang, text: data.translations[index] });
        });
      }
    });
  } catch (error) {
    console.error('[ERROR] [Translation] 翻譯失敗:', error.message);
    const apiHint = document.getElementById('api-hint');
    if (apiHint) {
      apiHint.textContent = '翻譯失敗，請檢查後端服務 URL 或 API Key';
      apiHint.classList.add('error');
    }
  }
}

export { sendTranslationRequest };
