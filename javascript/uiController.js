document.addEventListener('DOMContentLoaded', function() {
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
        
        console.debug('[DEBUG]', `Button ${buttonId} clicked, showing panel ${targetPanelId}`);
    }

    // 處理 apilink 按鈕點擊（占位符）
    function handleApiLinkClick() {
        console.debug('[DEBUG]', 'API link button clicked');
        // 待實現：例如 window.location.href = 'https://example.com/api';
    }

    // 處理 ray-mode 按鈕點擊（切換 active 狀態）
    function handleRayModeClick(button) {
        button.classList.toggle('active');
        const isActive = button.classList.contains('active');
        console.debug('[DEBUG]', `Ray mode toggled to ${isActive ? 'active' : 'inactive'}`);
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
            handleApiLinkClick();
        });
    } else {
        console.debug('[DEBUG]', 'API link button not found');
    }

    // 為 ray-mode 綁定事件
    const rayModeButton = document.getElementById('ray-mode');
    if (rayModeButton) {
        rayModeButton.addEventListener('click', function(e) {
            e.stopPropagation();
            handleRayModeClick(this);
        });
    } else {
        console.debug('[DEBUG]', 'Ray mode button not found');
    }

    // 共用函式：設置樣式選擇器的監聽器
    function setupStyleListener(inputId, textElementId, logDescription, cssProperty, inputType) {
        const inputElement = document.getElementById(inputId);
        if (inputElement) {
            // 從 localStorage 載入初始值
            const savedValue = localStorage.getItem(inputId);
            if (savedValue) {
                const textElement = document.getElementById(textElementId);
                if (textElement) {
                    inputElement.value = inputType === 'range' ? parseFloat(savedValue) : savedValue;
                    textElement.style.setProperty(cssProperty, savedValue);
                    console.debug('[DEBUG]', `${logDescription} ${cssProperty} loaded from localStorage: ${savedValue}`);
                } else {
                    console.debug('[DEBUG]', `${logDescription} element not found during initialization`);
                }
            }

            // 監聽 input 事件並儲存到 localStorage
            inputElement.addEventListener('input', function() {
                const textElement = document.getElementById(textElementId);
                if (textElement) {
                    const value = inputType === 'range' ? `${this.value}px` : this.value;
                    textElement.style.setProperty(cssProperty, value);
                    localStorage.setItem(inputId, value);
                    console.debug('[DEBUG]', `${logDescription} ${cssProperty} changed to ${value} and saved to localStorage`);
                } else {
                    console.debug('[DEBUG]', `${logDescription} element not found`);
                }
            });
        } else {
            console.debug('[DEBUG]', `${inputId} input not found`);
        }
    }

    // 為文字顏色選擇器設置監聽器
    setupStyleListener('source-font-color', 'source-text', 'Source text', '--text-color', 'color');
    setupStyleListener('target1-font-color', 'target-text-1', 'Target text 1', '--text-color', 'color');
    setupStyleListener('target2-font-color', 'target-text-2', 'Target text 2', '--text-color', 'color');
    setupStyleListener('target3-font-color', 'target-text-3', 'Target text 3', '--text-color', 'color');

    // 為外框顏色選擇器設置監聽器
    setupStyleListener('source-font-stroke-color', 'source-text', 'Source stroke', '--stroke-color', 'color');
    setupStyleListener('target1-font-stroke-color', 'target-text-1', 'Target stroke 1', '--stroke-color', 'color');
    setupStyleListener('target2-font-stroke-color', 'target-text-2', 'Target stroke 2', '--stroke-color', 'color');
    setupStyleListener('target3-font-stroke-color', 'target-text-3', 'Target stroke 3', '--stroke-color', 'color');

    // 為字型尺寸選擇器設置監聽器
    setupStyleListener('source-font-size', 'source-text', 'Source font size', '--text-font-size', 'range');
    setupStyleListener('target1-font-size', 'target-text-1', 'Target font size 1', '--text-font-size', 'range');
    setupStyleListener('target2-font-size', 'target-text-2', 'Target font size 2', '--text-font-size', 'range');
    setupStyleListener('target3-font-size', 'target-text-3', 'Target font size 3', '--text-font-size', 'range');

    // 為外框尺寸選擇器設置監聽器
    setupStyleListener('source-font-stroke-size', 'source-text', 'Source stroke size', '--stroke-width', 'range');
    setupStyleListener('target1-font-stroke-size', 'target-text-1', 'Target stroke size 1', '--stroke-width', 'range');
    setupStyleListener('target2-font-stroke-size', 'target-text-2', 'Target stroke size 2', '--stroke-width', 'range');
    setupStyleListener('target3-font-stroke-size', 'target-text-3', 'Target stroke size 3', '--stroke-width', 'range');
});