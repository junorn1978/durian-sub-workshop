// ==========================================================================
// 全局預設值與語言清單
// ==========================================================================
const DEFAULT_LANGUAGES = {
    "source-language": "ja",
    "target-language1": "none",
    "target-language2": "none",
    "target-language3": "none"
};

const DEFAULT_SETTINGS = {
    "source-language": {
        fontSize: 24,
        textStrokeSize: 5,
        textColor: "#FFFFFF",
        textStrokeColor: "#B46EFF"
    },
    "target-language1": {
        fontSize: 24,
        textStrokeSize: 5,
        textColor: "#FFFFFF",
        textStrokeColor: "#800080"
    },
    "target-language2": {
        fontSize: 24,
        textStrokeSize: 5,
        textColor: "#FFFFFF",
        textStrokeColor: "#FF0000"
    },
    "target-language3": {
        fontSize: 24,
        textStrokeSize: 5,
        textColor: "#FFFFFF",
        textStrokeColor: "#8D5524"
    },
    backgroundColor: "#00FF00",
    textAlignment: "left"
};

const LANGUAGE_OPTIONS = [
    { value: "ja", label: "日本語" },
    { value: "zh-TW", label: "繁体台湾語" },
    { value: "en", label: "英語" },
    { value: "es", label: "スペイン語" }
];

document.addEventListener("DOMContentLoaded", () => {
    console.log("styleController.js loaded successfully");

    // ==========================================================================
    // 初始化變數
    // ==========================================================================
    const languageSelectIds = ["source-language", "target-language1", "target-language2", "target-language3"];
    const elements = {
        apiKeyInput: document.getElementById("api-key-input"),
        apiKeyValue: document.getElementById("api-key-value"),
        toggleVisibilityUrl: document.getElementById("toggle-visibility-url"),
        toggleVisibilityKey: document.getElementById("toggle-visibility-key"),
        startSpeechButton: document.getElementById("start-recording"),
        stopSpeechButton: document.getElementById("stop-recording"),
        optionSelector: document.getElementById("option-language-selector"),
        fontSizeSlider: document.getElementById("font-size-slider"),
        textStrokeSlider: document.getElementById("text-stroke-slider"),
        textColorPicker: document.getElementById("text-color-picker"),
        textStrokeColorPicker: document.getElementById("text-stroke-color-picker"),
        backgroundColorPicker: document.getElementById("background-color-picker"),
        rightPanel: document.querySelector(".right-panel"),
        section: document.getElementById("section-1"),
        textAlignmentSelector: document.getElementById("text-alignment-selector")
    };

    const languageToSpanMap = {
        "source-language": ".source-text",
        "target-language1": ".target-text-1",
        "target-language2": ".target-text-2",
        "target-language3": ".target-text-3"
    };

    Object.entries(elements).forEach(([key, element]) => {
        if (!element) {
            console.error(`Element not found: ${key}`);
        }
    });

    // ==========================================================================
    // 動態生成語言選擇器選項
    // ==========================================================================
    languageSelectIds.forEach(id => {
        const selectElement = document.getElementById(id);
        if (!selectElement) {
            return console.error(`Language select not found: ${id}`);
        }

        const prefix = id === "source-language" ? "來源 - " : `語言${id.slice(-1)} - `;
        LANGUAGE_OPTIONS.forEach(option => {
            const optionElement = document.createElement("option");
            optionElement.value = option.value;
            optionElement.textContent = `${prefix}${option.label}`;
            selectElement.appendChild(optionElement);
        });

        const savedValue = localStorage.getItem(id);
        selectElement.value = savedValue || DEFAULT_LANGUAGES[id];

        selectElement.addEventListener("change", () => {
            localStorage.setItem(id, selectElement.value);
        });
    });

    // ==========================================================================
    // 輸入框遮蔽功能
    // ==========================================================================
    if (elements.apiKeyInput && elements.toggleVisibilityUrl) {
        const savedUrl = localStorage.getItem("api-key-input");
        if (savedUrl) elements.apiKeyInput.value = savedUrl;

        elements.apiKeyInput.addEventListener("input", () => {
            localStorage.setItem("api-key-input", elements.apiKeyInput.value);
        });

        elements.toggleVisibilityUrl.addEventListener("click", () => {
            const isPassword = elements.apiKeyInput.type === "password";
            elements.apiKeyInput.type = isPassword ? "text" : "password";
            elements.toggleVisibilityUrl.classList.toggle("visible", isPassword);
        });
    }

    if (elements.apiKeyValue && elements.toggleVisibilityKey) {
        const savedKey = localStorage.getItem("api-key-value");
        if (savedKey) elements.apiKeyValue.value = savedKey;

        elements.apiKeyValue.addEventListener("input", () => {
            localStorage.setItem("api-key-value", elements.apiKeyValue.value);
        });

        elements.toggleVisibilityKey.addEventListener("click", () => {
            const isPassword = elements.apiKeyValue.type === "password";
            elements.apiKeyValue.type = isPassword ? "text" : "password";
            elements.toggleVisibilityKey.classList.toggle("visible", isPassword);
        });
    }

    // ==========================================================================
    // 樣式控制功能
    // ==========================================================================
    if (elements.textColorPicker) {
        elements.textColorPicker.addEventListener("input", () => {
            updateSectionStyle("color", elements.textColorPicker.value);
            saveSettings({ textColor: elements.textColorPicker.value });
        });
    }

    if (elements.textStrokeColorPicker) {
        elements.textStrokeColorPicker.addEventListener("input", () => {
            updateSectionStyle("--stroke-color", elements.textStrokeColorPicker.value);
            saveSettings({ textStrokeColor: elements.textStrokeColorPicker.value });
        });
    }

    if (elements.backgroundColorPicker) {
        elements.backgroundColorPicker.addEventListener("input", () => {
            const color = elements.backgroundColorPicker.value;
            elements.rightPanel.style.backgroundColor = color;
            elements.section.style.backgroundColor = color;
            saveSettings({ backgroundColor: color });
        });
    }

    if (elements.fontSizeSlider) {
        elements.fontSizeSlider.addEventListener("input", () => {
            updateSectionStyle("fontSize", `${elements.fontSizeSlider.value}px`, true);
            saveSettings({ fontSize: elements.fontSizeSlider.value });
        });
    }

    if (elements.textStrokeSlider) {
        elements.textStrokeSlider.addEventListener("input", () => {
            updateSectionStyle("--stroke-width", `${elements.textStrokeSlider.value}px`);
            saveSettings({ textStrokeSize: elements.textStrokeSlider.value });
        });
    }

    // ==========================================================================
    // 選項選擇器與設定載入
    // ==========================================================================
    if (elements.optionSelector) {
        const savedOption = localStorage.getItem("selected-option-language");
        if (savedOption) {
            elements.optionSelector.value = savedOption;
        } else {
            localStorage.setItem("selected-option-language", elements.optionSelector.value);
        }

        languageSelectIds.forEach(language => {
            loadSettings(language);
        });

        elements.optionSelector.addEventListener("change", () => {
            const language = elements.optionSelector.value;
            localStorage.setItem("selected-option-language", language);
            loadSettings(language);
        });
    }

    // ==========================================================================
    // 文字對齊選單初始化與功能
    // ==========================================================================
    if (elements.textAlignmentSelector) {
        const savedAlignment = localStorage.getItem("text-alignment");
        elements.textAlignmentSelector.value = savedAlignment || DEFAULT_SETTINGS.textAlignment;
        applyTextAlignment(elements.textAlignmentSelector.value);

        elements.textAlignmentSelector.addEventListener("change", () => {
            const alignment = elements.textAlignmentSelector.value;
            localStorage.setItem("text-alignment", alignment);
            applyTextAlignment(alignment);
        });
    }

    // ==========================================================================
    // 全螢幕切換功能（無翻頁效果）
    // ==========================================================================
    if (elements.rightPanel) {
        let isFullscreen = false;

        elements.rightPanel.addEventListener("click", (event) => {
            if (event.target === elements.rightPanel || event.target.classList.contains("scroll-container")) {
                if (!isFullscreen) {
                    // 進入全螢幕
                    document.querySelector(".left-panel").classList.add("hidden");
                    elements.rightPanel.classList.add("fullscreen");
                    document.body.classList.add("no-scroll");
                    isFullscreen = true;
                    console.log("Right panel switched to fullscreen mode.");
                } else {
                    // 退出全螢幕
                    document.querySelector(".left-panel").classList.remove("hidden");
                    elements.rightPanel.classList.remove("fullscreen");
                    document.body.classList.remove("no-scroll");
                    isFullscreen = false;
                    console.log("Right panel exited fullscreen mode.");
                }
            }
        });
    }

    // ==========================================================================
    // 恢復預設值按鈕
    // ==========================================================================
    const resetButton = document.getElementById("reset-settings");
    if (resetButton) {
        resetButton.addEventListener("click", () => {
            // 重置語言相關樣式設置
            languageSelectIds.forEach(language => {
                const defaults = DEFAULT_SETTINGS[language];
                localStorage.setItem(`${language}-font-size`, defaults.fontSize);
                localStorage.setItem(`${language}-text-stroke-size`, defaults.textStrokeSize);
                localStorage.setItem(`${language}-text-color`, defaults.textColor);
                localStorage.setItem(`${language}-text-stroke-color`, defaults.textStrokeColor);
            });

            // 重置背景色
            localStorage.setItem("background-color", DEFAULT_SETTINGS.backgroundColor);

            // 更新樣式控制元件的值（基於當前語言樣式選擇器）
            const currentLanguage = elements.optionSelector.value;
            const currentDefaults = DEFAULT_SETTINGS[currentLanguage];
            if (elements.fontSizeSlider) elements.fontSizeSlider.value = currentDefaults.fontSize;
            if (elements.textStrokeSlider) elements.textStrokeSlider.value = currentDefaults.textStrokeSize;
            if (elements.textColorPicker) elements.textColorPicker.value = currentDefaults.textColor;
            if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = currentDefaults.textStrokeColor;
            if (elements.backgroundColorPicker) elements.backgroundColorPicker.value = DEFAULT_SETTINGS.backgroundColor;

            // 更新所有語言的文字樣式
            languageSelectIds.forEach(language => {
                const defaults = DEFAULT_SETTINGS[language];
                const spanClass = languageToSpanMap[language];
                const span = elements.section.querySelector(spanClass);
                if (span) {
                    span.style.fontSize = `${defaults.fontSize}px`;
                    span.style.color = defaults.textColor;
                    span.style.setProperty("--stroke-width", `${defaults.textStrokeSize}px`);
                    span.style.setProperty("--stroke-color", defaults.textStrokeColor);
                    if (span.textContent && span.getAttribute("data-stroke") !== span.textContent) {
                        span.setAttribute("data-stroke", span.textContent);
                    }
                }
            });

            // 更新面板和區段背景色
            if (elements.rightPanel) elements.rightPanel.style.backgroundColor = DEFAULT_SETTINGS.backgroundColor;
            if (elements.section) elements.section.style.backgroundColor = DEFAULT_SETTINGS.backgroundColor;

            // 重置文字對齊
            if (elements.textAlignmentSelector) {
                elements.textAlignmentSelector.value = DEFAULT_SETTINGS.textAlignment;
                localStorage.setItem("text-alignment", DEFAULT_SETTINGS.textAlignment);
                applyTextAlignment(DEFAULT_SETTINGS.textAlignment);
            }

            // 載入當前語言的設置
            if (elements.optionSelector) {
                loadSettings(elements.optionSelector.value);
            }

            console.log("Settings reset to defaults (excluding language selectors and option selector) and all styles refreshed.");
        });
    }

    // ==========================================================================
    // 輔助函數
    // ==========================================================================
    function updateSectionStyle(property, value, isSectionLevel = false) {
        const spanClass = languageToSpanMap[elements.optionSelector.value];
        const span = elements.section.querySelector(spanClass);
        if (span) {
            if (isSectionLevel) {
                span.style[property] = value;
            } else {
                span.style.setProperty(property, value);
            }
            if (!span.getAttribute("data-stroke") || span.getAttribute("data-stroke") !== span.textContent) {
                span.setAttribute("data-stroke", span.textContent);
            }
        } else {
            console.error(`Span not found for class: ${spanClass}`);
        }
    }

    function loadSettings(language) {
        const defaults = DEFAULT_SETTINGS[language];
        const settings = {
            fontSize: Math.min(Math.max(localStorage.getItem(`${language}-font-size`) || defaults.fontSize, 10), 100),
            textStrokeSize: Math.min(Math.max(localStorage.getItem(`${language}-text-stroke-size`) || defaults.textStrokeSize, 0), 10),
            textColor: localStorage.getItem(`${language}-text-color`) || defaults.textColor,
            textStrokeColor: localStorage.getItem(`${language}-text-stroke-color`) || defaults.textStrokeColor,
            backgroundColor: localStorage.getItem("background-color") || DEFAULT_SETTINGS.backgroundColor
        };

        if (elements.fontSizeSlider) elements.fontSizeSlider.value = settings.fontSize;
        if (elements.textStrokeSlider) elements.textStrokeSlider.value = settings.textStrokeSize;
        if (elements.textColorPicker) elements.textColorPicker.value = settings.textColor;
        if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = settings.textStrokeColor;
        if (elements.backgroundColorPicker) elements.backgroundColorPicker.value = settings.backgroundColor;

        const spanClass = languageToSpanMap[language];
        const span = elements.section.querySelector(spanClass);
        if (span) {
            span.style.fontSize = `${settings.fontSize}px`;
            span.style.color = settings.textColor;
            span.style.setProperty("--stroke-width", `${settings.textStrokeSize}px`);
            span.style.setProperty("--stroke-color", settings.textStrokeColor);
            if (!span.getAttribute("data-stroke") || span.getAttribute("data-stroke") !== span.textContent) {
                span.setAttribute("data-stroke", span.textContent);
            }
        }

        if (elements.rightPanel && elements.section) {
            elements.rightPanel.style.backgroundColor = settings.backgroundColor;
            elements.section.style.backgroundColor = settings.backgroundColor;
        }
    }

    function saveSettings(settings) {
        const language = elements.optionSelector.value;
        if (settings.fontSize !== undefined) {
            localStorage.setItem(`${language}-font-size`, settings.fontSize);
            console.log(`Saved ${language}-font-size: ${settings.fontSize}`);
        }
        if (settings.textStrokeSize !== undefined) {
            localStorage.setItem(`${language}-text-stroke-size`, settings.textStrokeSize);
            console.log(`Saved ${language}-text-stroke-size: ${settings.textStrokeSize}`);
        }
        if (settings.textColor !== undefined) {
            localStorage.setItem(`${language}-text-color`, settings.textColor);
            console.log(`Saved ${language}-text-color: ${settings.textColor}`);
        }
        if (settings.textStrokeColor !== undefined) {
            localStorage.setItem(`${language}-text-stroke-color`, settings.textStrokeColor);
            console.log(`Saved ${language}-text-stroke-color: ${settings.textStrokeColor}`);
        }
        if (settings.backgroundColor !== undefined) {
            localStorage.setItem("background-color", settings.backgroundColor);
            console.log(`Saved background-color: ${settings.backgroundColor}`);
        }
        refreshAllStyles(); // 每次保存設置時更新所有樣式
    }

    function refreshAllStyles() {
        const section = document.getElementById("section-1");
        if (!section) return;

        const spans = {
            "source-language": section.querySelector(".source-text"),
            "target-language1": section.querySelector(".target-text-1"),
            "target-language2": section.querySelector(".target-text-2"),
            "target-language3": section.querySelector(".target-text-3")
        };

        Object.entries(spans).forEach(([lang, span]) => {
            if (span) {
                const settings = {
                    fontSize: localStorage.getItem(`${lang}-font-size`) || DEFAULT_SETTINGS[lang].fontSize,
                    textColor: localStorage.getItem(`${lang}-text-color`) || DEFAULT_SETTINGS[lang].textColor,
                    textStrokeSize: localStorage.getItem(`${lang}-text-stroke-size`) || DEFAULT_SETTINGS[lang].textStrokeSize,
                    textStrokeColor: localStorage.getItem(`${lang}-text-stroke-color`) || DEFAULT_SETTINGS[lang].textStrokeColor
                };
                span.style.fontSize = `${settings.fontSize}px`;
                span.style.color = settings.textColor;
                span.style.setProperty("--stroke-width", `${settings.textStrokeSize}px`);
                span.style.setProperty("--stroke-color", settings.textStrokeColor);
                if (span.textContent && span.getAttribute("data-stroke") !== span.textContent) {
                    span.setAttribute("data-stroke", span.textContent);
                }
            }
        });
    }

    function applyTextAlignment(alignment) {
        const scrollContainer = elements.section.querySelector(".scroll-container");
        if (scrollContainer) {
            scrollContainer.style.textAlign = alignment;
        } else {
            console.error("Scroll container not found for text alignment.");
        }
    }
});