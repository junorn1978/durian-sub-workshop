import { sendTranslationRequest, sendTranslation, bcp47ToLanguageName } from './translationController_temp.js';

document.addEventListener('DOMContentLoaded', function() {
  // 定義所有設定
  const settings = [
    { inputId: 'source-font-color', textElementId: 'source-text', cssProperty: '--text-color', inputType: 'color', logDescription: 'Source text' },
    { inputId: 'target1-font-color', textElementId: 'target-text-1', cssProperty: '--text-color', inputType: 'color', logDescription: 'Target text 1' },
    { inputId: 'target2-font-color', textElementId: 'target-text-2', cssProperty: '--text-color', inputType: 'color', logDescription: 'Target text 2' },
    { inputId: 'target3-font-color', textElementId: 'target-text-3', cssProperty: '--text-color', inputType: 'color', logDescription: 'Target text 3' },
    { inputId: 'source-font-stroke-color', textElementId: 'source-text', cssProperty: '--stroke-color', inputType: 'color', logDescription: 'Source stroke' },
    { inputId: 'target1-font-stroke-color', textElementId: 'target-text-1', cssProperty: '--stroke-color', inputType: 'color', logDescription: 'Target stroke 1' },
    { inputId: 'target2-font-stroke-color', textElementId: 'target-text-2', cssProperty: '--stroke-color', inputType: 'color', logDescription: 'Target stroke 2' },
    { inputId: 'target3-font-stroke-color', textElementId: 'target-text-3', cssProperty: '--stroke-color', inputType: 'color', logDescription: 'Target stroke 3' },
    { inputId: 'source-font-size', textElementId: 'source-text', cssProperty: '--text-font-size', inputType: 'range', logDescription: 'Source font size' },
    { inputId: 'target1-font-size', textElementId: 'target-text-1', cssProperty: '--text-font-size', inputType: 'range', logDescription: 'Target font size 1' },
    { inputId: 'target2-font-size', textElementId: 'target-text-2', cssProperty: '--text-font-size', inputType: 'range', logDescription: 'Target font size 2' },
    { inputId: 'target3-font-size', textElementId: 'target-text-3', cssProperty: '--text-font-size', inputType: 'range', logDescription: 'Target font size 3' },
    { inputId: 'source-font-stroke-size', textElementId: 'source-text', cssProperty: '--stroke-width', inputType: 'range', logDescription: 'Source stroke size' },
    { inputId: 'target1-font-stroke-size', textElementId: 'target-text-1', cssProperty: '--stroke-width', inputType: 'range', logDescription: 'Target stroke size 1' },
    { inputId: 'target2-font-stroke-size', textElementId: 'target-text-2', cssProperty: '--stroke-width', inputType: 'range', logDescription: 'Target stroke size 2' },
    { inputId: 'target3-font-stroke-size', textElementId: 'target-text-3', cssProperty: '--stroke-width', inputType: 'range', logDescription: 'Target stroke size 3' }
  ];

  // 定義所有面板的 ID
  const panels = {
    'source1': 'source-styles-panel',
    'target1': 'target1-styles-panel',
    'target2': 'target2-styles-panel',
    'target3': 'target3-styles-panel',
    'options': 'options-panel',
    'comment': 'comment-translation',
    'usage': 'usage-guide'
  };

  // 文字水平排列方面的定義
  const alignmentSettings = {
    inputName: 'alignment',
    elements: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
    cssProperty: '--text-align',
    logDescription: 'Text alignment'
  };

  // 溢出處理設定的定義
  const overflowSettings = {
    inputName: 'overflow',
    elements: ['source-text', 'target-text-1', 'target-text-2', 'target-text-3'],
    logDescription: 'Overflow mode'
  };

  // 儲存到 localStorage 的共用函式
  function saveToLocalStorage(inputId, value, logDescription) {
    localStorage.setItem(inputId, value);
    // console.debug('[DEBUG] [UIController]', `${logDescription} 已儲存至 localStorage: ${value}`);
  }

  // 載入值的共用函式
  function loadFromLocalStorage(inputId, textElementId, cssProperty, inputType, logDescription, eventType) {
    if (eventType === 'raymode') {
      const savedValue = localStorage.getItem(inputId);
      if (!savedValue) {
        // console.debug('[DEBUG] [UIController]', `${logDescription} 未在 localStorage 中找到`);
        return;
      }
      
      const rayModeButton = document.getElementById('raymode');
      if (!rayModeButton) {
        // console.debug('[DEBUG] [UIController]', `未找到 Raymode 按鈕`);
        return;
      }
      
      if (savedValue === 'true') {
        rayModeButton.classList.add('active');
      } else {
        rayModeButton.classList.remove('active');
      }
      
      // console.debug('[DEBUG] [UIController]', `${logDescription} 從 localStorage 載入: ${savedValue}`);
      return;
    }

    if (eventType === 'overflow') {
      const savedValue = localStorage.getItem(inputId) || 'normal';
      const radioToCheck = document.querySelector(`input[name="overflow"][value="${savedValue}"]`);
      if (radioToCheck) {
        radioToCheck.checked = true;
        applyOverflow(savedValue);
        // console.debug('[DEBUG] [UIController]', `${logDescription} 從 localStorage 載入: ${savedValue}`);
      }
      return;
    }
  
    const inputElement = document.getElementById(inputId);
    if (!inputElement) {
      // console.debug('[DEBUG] [UIController]', `${inputId} 輸入框未找到`);
      return;
    }
    
    const textElement = eventType !== 'select' && eventType !== 'text' ? document.getElementById(textElementId) : null;
    if (eventType === 'color' || eventType === 'range') {
      if (!textElement) {
        // console.debug('[DEBUG] [UIController]', `${logDescription} 元素在初始化時未找到`);
        return;
      }
    }
  
    const savedValue = localStorage.getItem(inputId);
    let valueToApply = savedValue;
  
    // 如果 localStorage 沒有值，則從 CSS 獲取預設值
    if (!savedValue && (eventType === 'color' || eventType === 'range')) {
      valueToApply = getDefaultValueFromCSS(cssProperty, inputId, logDescription);
      if (valueToApply) {
        inputElement.value = eventType === 'range' ? parseFloat(valueToApply) : valueToApply;
        textElement.style.setProperty(cssProperty, valueToApply);
        // console.debug('[DEBUG] [UIController]', `${logDescription} ${cssProperty} 從 CSS 載入預設值: ${valueToApply}`);

        // 如果是 --text-font-size，同步載入 --overflow-height 和 --font-size-half
        if (cssProperty === '--text-font-size') {
          const savedOverflowHeight = localStorage.getItem(`${inputId}-overflow-height`);
          const defaultOverflowHeight = `${parseFloat(valueToApply) * 1.2}px`;
          const overflowHeightToApply = savedOverflowHeight || defaultOverflowHeight;
          textElement.style.setProperty('--overflow-height', overflowHeightToApply);
          // console.debug('[DEBUG] [UIController]', `${logDescription} overflow height 從 ${savedOverflowHeight ? 'localStorage' : 'CSS'} 載入: ${overflowHeightToApply}`);

          const savedFontSizeHalf = localStorage.getItem(`${inputId}-font-size-half`);
          const defaultFontSizeHalf = `${parseFloat(valueToApply) * 0.75}px`;
          const fontSizeHalfToApply = savedFontSizeHalf || defaultFontSizeHalf;
          textElement.style.setProperty('--font-size-half', fontSizeHalfToApply);
          // console.debug('[DEBUG] [UIController]', `${logDescription} font size half 從 ${savedFontSizeHalf ? 'localStorage' : 'CSS'} 載入: ${fontSizeHalfToApply}`);
        }
        return;
      }
    }
  
    if (savedValue) {
      if (eventType === 'select' || eventType === 'text') {
        inputElement.value = savedValue;
        // console.debug('[DEBUG] [UIController]', `${logDescription} 從 localStorage 載入: ${savedValue}`);
        return;
      }
      
      if (eventType === 'color' || eventType === 'range') {
        inputElement.value = eventType === 'range' ? parseFloat(savedValue) : savedValue;
        textElement.style.setProperty(cssProperty, savedValue);
        // console.debug('[DEBUG] [UIController]', `${logDescription} ${cssProperty} 從 localStorage 載入: ${savedValue}`);

        // 如果是 --text-font-size，同步載入 --overflow-height 和 --font-size-half
        if (cssProperty === '--text-font-size') {
          const savedOverflowHeight = localStorage.getItem(`${inputId}-overflow-height`);
          const overflowHeightToApply = savedOverflowHeight || `${parseFloat(savedValue) * 1.2}px`;
          textElement.style.setProperty('--overflow-height', overflowHeightToApply);
          // console.debug('[DEBUG] [UIController]', `${logDescription} overflow height 從 localStorage 載入: ${overflowHeightToApply}`);

          const savedFontSizeHalf = localStorage.getItem(`${inputId}-font-size-half`);
          const fontSizeHalfToApply = savedFontSizeHalf || `${parseFloat(savedValue) * 0.75}px`;
          textElement.style.setProperty('--font-size-half', fontSizeHalfToApply);
          // console.debug('[DEBUG] [UIController]', `${logDescription} font size half 從 localStorage 載入: ${fontSizeHalfToApply}`);
        }
        return;
      }
    }
  
    // console.debug('[DEBUG] [UIController]', `未知的 eventType: ${eventType} 對 ${inputId}`);
  }

  // 從 CSS 獲取預設值
  function getDefaultValueFromCSS(cssProperty, inputId, logDescription) {
    const cssValue = getComputedStyle(document.documentElement).getPropertyValue(cssProperty).trim();
    if (!cssValue) {
      // console.debug('[DEBUG] [UIController]', `未找到 ${cssProperty} 的預設值，針對 ${inputId}，跳過重置`);
      return null;
    }
    // console.debug('[DEBUG] [UIController]', `從 CSS 獲取 ${inputId} 的預設值: ${cssValue}`);
    return cssValue;
  }

  // 重置單個設定
  function resetSetting(inputId, textElementId, cssProperty, inputType, logDescription) {
    const inputElement = document.getElementById(inputId);
    const textElement = document.getElementById(textElementId);
    if (inputElement && textElement) {
      const defaultValue = getDefaultValueFromCSS(cssProperty, inputId, logDescription);
      if (defaultValue) {
        inputElement.value = inputType === 'range' ? parseFloat(defaultValue) : defaultValue;
        textElement.style.setProperty(cssProperty, defaultValue);
        saveToLocalStorage(inputId, defaultValue, logDescription);

        // 如果是 --text-font-size，同步重置 --overflow-height 和 --font-size-half
        if (cssProperty === '--text-font-size') {
          const defaultOverflowHeight = `${parseFloat(defaultValue) * 1.2}px`;
          textElement.style.setProperty('--overflow-height', defaultOverflowHeight);
          saveToLocalStorage(`${inputId}-overflow-height`, defaultOverflowHeight, `${logDescription} overflow height`);
          // console.debug('[DEBUG] [UIController]', `重置 ${logDescription} overflow height 至 CSS 的 ${defaultOverflowHeight}`);

          const defaultFontSizeHalf = `${parseFloat(defaultValue) * 0.75}px`;
          textElement.style.setProperty('--font-size-half', defaultFontSizeHalf);
          saveToLocalStorage(`${inputId}-font-size-half`, defaultFontSizeHalf, `${logDescription} font size half`);
          // console.debug('[DEBUG] [UIController]', `重置 ${logDescription} font size half 至 CSS 的 ${defaultFontSizeHalf}`);
        }
      }
    } else {
      // console.debug('[DEBUG] [UIController]', `重置失敗: ${inputId} 或 ${textElementId} 未找到`);
    }
  }

  // 重置所有設定
  function resetAllSettings() {
    settings.forEach(setting => {
      resetSetting(setting.inputId, setting.textElementId, setting.cssProperty, setting.inputType, setting.textElementId);
    });

    // 重置 display-panel-color
    const inputElement = document.getElementById('display-panel-color');
    if (inputElement) {
      const defaultValue = getComputedStyle(document.documentElement).getPropertyValue('--body-background').trim() || '#00FF00';
      inputElement.value = defaultValue;
      document.body.style.setProperty('--body-background', defaultValue);
      localStorage.setItem('display-panel-color', defaultValue);
      // console.debug('[DEBUG] [UIController]', `重置 Body background color 至 CSS 的 ${defaultValue}`);
    } else {
      // console.debug('[DEBUG] [UIController]', '重置失敗: display-panel-color 未找到');
    }

    // 重置 raymode 的 active 狀態
    const rayModeButton = document.getElementById('raymode');
    rayModeButton.classList.remove('active');

    // 重置對齊方式
    const defaultAlignment = 'center';
    applyAlignment(defaultAlignment);
    const radioToCheck = document.querySelector(`input[name="alignment"][value="${defaultAlignment}"]`);
    if (radioToCheck) {
      radioToCheck.checked = true;
      saveToLocalStorage('text-alignment', defaultAlignment, 'Text alignment');
    }

    // 重置溢出模式
    const defaultOverflow = 'normal';
    applyOverflow(defaultOverflow);
    const overflowRadioToCheck = document.querySelector(`input[name="overflow"][value="${defaultOverflow}"]`);
    if (overflowRadioToCheck) {
      overflowRadioToCheck.checked = true;
      saveToLocalStorage('overflow-mode', defaultOverflow, 'Overflow mode');
    }
  }

  // 設定顯示文字背景色
  function setupBackgroundColorListener() {
    const inputElement = document.getElementById('display-panel-color');
    if (!inputElement) {
      // console.debug('[DEBUG] [UIController]', 'display-panel-color 輸入框未找到');
      return;
    }

    // 初始化：從 localStorage 載入或使用 CSS 預設值
    const savedValue = localStorage.getItem('display-panel-color');
    const defaultValue = getComputedStyle(document.documentElement).getPropertyValue('--body-background').trim() || '#00FF00';
    const valueToApply = savedValue || defaultValue;
    inputElement.value = valueToApply;
    document.body.style.setProperty('--body-background', valueToApply);
    // console.debug('[DEBUG] [UIController]', `Body background color 從 ${savedValue ? 'localStorage' : 'CSS'} 載入: ${valueToApply}`);

    // 監聽 input 事件：更新 body 的 --body-background 並儲存
    inputElement.addEventListener('input', function() {
      const value = this.value;
      document.body.style.setProperty('--body-background', value);
      localStorage.setItem('display-panel-color', value);
      // console.debug('[DEBUG] [UIController]', `Body background color 更新為: ${value}`);
    });
  }

  // 處理面板切換的按鈕點擊
  function handleButtonClick(button, buttonId) {
    // 移除所有按鈕的 active 類
    document.querySelectorAll('.menu-button').forEach(btn => btn.classList.remove('active'));
    
    // 為當前按鈕添加 active 類
    button.classList.add('active');
    
    // 隱藏所有面板
    Object.values(panels).forEach(panelId => {
      const panel = document.getElementById(panelId);
      if (panel) {
        panel.style.display = 'none';
      }
    });
    
    // 顯示對應的面板
    const targetPanelId = panels[buttonId];
    if (targetPanelId) {
      const targetPanel = document.getElementById(targetPanelId);
      if (targetPanel) {
        targetPanel.style.display = 'flex';
      }
    }
    
    // console.debug('[DEBUG] [UIController]', `按鈕 ${buttonId} 被點擊，顯示面板 ${targetPanelId}`);
  }

  // 處理 apilink 按鈕點擊
  function handleApiLinkClick(button) {
    const isActive = button.classList.contains('active');
    const translationLink = document.getElementById('translation-link');
    const menuButtons = document.querySelectorAll('.menu-button');
    
    if (!translationLink) {
      // console.debug('[DEBUG] [UIController]', '未找到元素ID [translation-link]');
      return;
    }
    
    if (isActive) {
      // 取消 active 狀態，恢復 menu-button
      button.classList.remove('active');
      menuButtons.forEach(btn => {
        btn.style.display = 'inline-block';
      });
      translationLink.style.display = 'none';
    } else {
      // 設置 active 狀態，隱藏 menu-button
      button.classList.add('active');
      menuButtons.forEach(btn => {
        btn.style.display = 'none';
      });
      translationLink.style.display = 'inline-block';
    }
  }

  // 處理 raymode 按鈕點擊（切換 active 狀態）
  function handleRayModeClick(button) {
    button.classList.toggle('active');
    const isActive = button.classList.contains('active');
    saveToLocalStorage('raymode-active', isActive.toString(), 'Raymode active state');
    // console.debug('[DEBUG] [UIController]', `Raymode toggled to ${isActive ? 'active' : 'inactive'}`);
  }

  // 設置語言選單的監聽器
  function setupLanguageListener(inputId, logDescription) {
    const selectElement = document.getElementById(inputId);
    loadFromLocalStorage(inputId, null, null, null, logDescription, 'select');
    selectElement.addEventListener('change', function() {
      const value = this.value;
      saveToLocalStorage(inputId, value, logDescription);
    
      // 檢查是否選擇 "none" 並清除對應的文字元素
      const targetTextMap = {
        'target1-language': 'target-text-1',
        'target2-language': 'target-text-2',
        'target3-language': 'target-text-3'
      };
      const targetTextId = targetTextMap[inputId];
      if (targetTextId && value === 'none') {
        const textElement = document.getElementById(targetTextId);
        textElement.textContent = '\u200B';
        textElement.setAttribute("data-stroke", "\u200B");
        // console.debug('[DEBUG] [UIController]', `清除 ${targetTextId} 的文字內容`);
      }
    });
  }

  // 設置翻譯連結輸入框的監聽器
  function setupTranslationLinkListener() {
    const translationLink = document.getElementById('translation-link');
    if (translationLink) {
      loadFromLocalStorage('translation-link', null, null, null, 'Translation link', 'text');
      translationLink.addEventListener('input', function() {
        const value = this.value;
        saveToLocalStorage('translation-link', value, 'Translation link');
      });
    } else {
      // console.debug('[DEBUG] [UIController]', 'Translation link input not found');
    }
  }

  // 設置樣式選擇器的監聽器
  function setupStyleListener(inputId, textElementId, cssProperty, inputType, logDescription) {
    const inputElement = document.getElementById(inputId);
    if (inputElement) {
      loadFromLocalStorage(inputId, textElementId, cssProperty, inputType, logDescription, inputType);
      inputElement.addEventListener('input', function() {
        const textElement = document.getElementById(textElementId);
        if (textElement) {
          const value = inputType === 'range' ? `${this.value}px` : this.value;
          textElement.style.setProperty(cssProperty, value);
          saveToLocalStorage(inputId, value, logDescription);

          // 如果更新的是 --text-font-size，同步更新 --overflow-height 和 --font-size-half
          if (cssProperty === '--text-font-size') {
            const fontSize = parseFloat(this.value);
            const overflowHeight = `${fontSize * 1.2}px`;
            const fontSizeHalf = `${fontSize * 0.75}px`;
            textElement.style.setProperty('--overflow-height', overflowHeight);
            textElement.style.setProperty('--font-size-half', fontSizeHalf);
            saveToLocalStorage(`${inputId}-overflow-height`, overflowHeight, `${logDescription} overflow height`);
            saveToLocalStorage(`${inputId}-font-size-half`, fontSizeHalf, `${logDescription} font size half`);
            // console.debug('[DEBUG] [UIController]', `${logDescription} overflow height 更新為: ${overflowHeight}`);
            // console.debug('[DEBUG] [UIController]', `${logDescription} font size half 更新為: ${fontSizeHalf}`);
          }
        } else {
          // console.debug('[DEBUG] [UIController]', `${logDescription} element not found`);
        }
      });
    } else {
      // console.debug('[DEBUG] [UIController]', `${inputId} input not found`);
    }
  }

  // 設置溢出模式的監聽器
  function setupOverflowListener() {
    const radioButtons = document.querySelectorAll('input[name="overflow"]');
    if (radioButtons.length === 0) {
      // console.debug('[DEBUG] [UIController]', '溢出模式 radio 按鈕未找到');
      return;
    }

    // 載入儲存的溢出模式或使用預設值
    loadFromLocalStorage('overflow-mode', null, null, null, 'Overflow mode', 'overflow');

    // 為每個 radio 按鈕綁定 change 事件
    radioButtons.forEach(radio => {
      radio.addEventListener('change', function() {
        if (this.checked) {
          const value = this.value;
          applyOverflow(value);
          saveToLocalStorage('overflow-mode', value, 'Overflow mode');
          // console.debug('[DEBUG] [UIController]', `溢出模式變更為 ${value}`);
        }
      });
    });
  }

  // 應用溢出模式到所有文字元素
  function applyOverflow(value, specificElementId = null) {
    const elements = specificElementId ? [specificElementId] : overflowSettings.elements;
    elements.forEach(elementId => {
      const element = document.getElementById(elementId);
      if (element) {
        // 移除所有溢出相關類
        element.classList.remove('overflow-normal', 'overflow-shrink', 'overflow-truncate');
        // 添加對應的溢出類
        element.classList.add(`overflow-${value}`);
        // console.debug('[DEBUG] [UIController]', `應用溢出模式 ${value} 到 ${elementId}`);
      }
    });
  }

  // 為 menu-button 按鈕綁定事件
  document.querySelectorAll('.menu-button').forEach(button => {
    button.addEventListener('click', function() {
      handleButtonClick(this, this.id);
    });
  });

  // 為 apilink 綁定事件
  const apiLinkButton = document.getElementById('apilink');
  if (apiLinkButton) {
    apiLinkButton.addEventListener('click', function(e) {
      e.stopPropagation();
      handleApiLinkClick(this);
    });
  } else {
    // console.debug('[DEBUG] [UIController]', 'API link button not found');
  }

  // 為 raymode 綁定事件並初始化
  const rayModeButton = document.getElementById('raymode');
  if (rayModeButton) {
    rayModeButton.addEventListener('click', function(e) {
      e.stopPropagation();
      handleRayModeClick(this);
    });
    loadFromLocalStorage('raymode-active', null, null, null, 'Raymode 活躍狀態', 'raymode');
  } else {
    // console.debug('[DEBUG] [UIController]', '未找到 Raymode 按鈕');
  }

  // 為 reset-settings 綁定事件
  const resetButton = document.getElementById('reset-settings');
  if (resetButton) {
    resetButton.addEventListener('click', function(e) {
      e.stopPropagation();
      resetAllSettings();
    });
  } else {
    // console.debug('[DEBUG] [UIController]', 'Reset settings button not found');
  }

  // 設置對齊方式的監聽器
  function setupAlignmentListener() {
    const radioButtons = document.querySelectorAll('input[name="alignment"]');
    if (radioButtons.length === 0) {
      // console.debug('[DEBUG] [UIController]', '對 SurveyJS - Survey Creator Example齊方式 radio 按鈕未找到');
      return;
    }
    
    // 載入儲存的對齊方式或使用預設值
    const savedAlignment = localStorage.getItem('text-alignment') || 'center';
    const radioToCheck = document.querySelector(`input[name="alignment"][value="${savedAlignment}"]`);
    
    radioToCheck.checked = true;
    applyAlignment(savedAlignment);
    // console.debug('[DEBUG] [UIController]', `從 localStorage 載入對齊方式: ${savedAlignment}`);
    
    // 為每個 radio 按鈕綁定 change 事件
    radioButtons.forEach(radio => {
      radio.addEventListener('change', function() {
        if (this.checked) {
          const value = this.value;
          applyAlignment(value);
          saveToLocalStorage('text-alignment', value, 'Text alignment');
          // console.debug('[DEBUG] [UIController]', `對齊方式變更為 ${value}`);
        }
      });
    });
  }
  
  // 應用對齊方式到所有文字元素
  function applyAlignment(value) {
    alignmentSettings.elements.forEach(elementId => {
      const element = document.getElementById(elementId);
      element.style.setProperty(alignmentSettings.cssProperty, value);
    });
  }

  // 翻譯留言視窗的事件設定
  const translationButton = document.getElementById('translation1');
  const commentInput = document.getElementById('comment-input');

  translationButton.addEventListener('click', async () => {
    const text = commentInput.value.trim();
    const sourceLang = document.querySelector('input[name="comment-lang"]:checked')?.value;
    const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
    
    if (!text || !sourceLang) {
      console.error('[ERROR] [UIController]', '無效輸入或未選擇語言');
      const translationComm = document.getElementById('translation-comm');
      translationComm.textContent = 'Please enter text and select a language.';
      return;
    }

    const serviceUrl = document.getElementById('translation-link').value;
    const targetLang = bcp47ToLanguageName[sourceLang] || sourceLang.split('-')[0];

    try {
      // console.debug('[DEBUG] [UIController]', '發送留言翻譯請求:', { text, sourceLang, targetLang });
      const data = await sendTranslation(text, [targetLang], serviceUrl, '');

      if (data && data.translations && data.translations[0]) {
        requestAnimationFrame(() => {
          const isRayModeActive = document.getElementById('raymode')?.classList.contains('active') || false;
          const filteredText = data.translations[0];
          const translationComm = document.getElementById('translation-comm');
          translationComm.textContent = filteredText;
          translationComm.dataset.stroke = filteredText;
          console.info('[INFO] [UIController]', '更新留言翻譯結果:', { lang: targetLang, text: filteredText });
        });
      } else {
        console.error('[ERROR] [UIController]', '無有效翻譯結果');
        const translationComm = document.getElementById('translation-comm');
        translationComm.textContent = 'No translation result';
      }
    } catch (error) {
      console.error('[ERROR] [UIController]', '翻譯失敗:', error.message);
      const translationComm = document.getElementById('translation-comm');
      translationComm.textContent = 'translation failed';
    }
  });
  
  // 為語言選單綁定監聽器
  setupLanguageListener('source-language', 'Source language');
  setupLanguageListener('target1-language', 'Target language 1');
  setupLanguageListener('target2-language', 'Target language 2');
  setupLanguageListener('target3-language', 'Target language 3');
  
  // 為翻譯連結輸入框綁定監聽器
  setupTranslationLinkListener();

  // 為樣式設定綁定監聽器
  settings.forEach(setting => {
    setupStyleListener(setting.inputId, setting.textElementId, setting.cssProperty, setting.inputType, setting.logDescription);
  });
  
  // 為對齊方式綁定監聽器
  setupAlignmentListener();
  
  // 為溢出模式綁定監聽器
  setupOverflowListener();
  
  // 修改顯示文字的背景顏色
  setupBackgroundColorListener();
});