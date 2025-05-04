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
    textAlignment: "left",
    textTruncateMode: "truncate" // 新增：文字截斷模式的預設值
};

const LANGUAGE_OPTIONS = [
    { value: "ja", label: "日本語" },
    { value: "zh-TW", label: "繁体台湾語" },
    { value: "en", label: "英語" },
    { value: "es", label: "スペイン語" },
    { value: "id", label: "インドネシア語" }
];

// ==========================================================================
// 輔助函數
// ==========================================================================
let elements = {};
const languageToSpanMap = {
    "source-language": ".source-text",
    "target-language1": ".target-text-1",
    "target-language2": ".target-text-2",
    "target-language3": ".target-text-3"
};

document.addEventListener("DOMContentLoaded", () => {
    console.log("styleController.js loaded successfully");

    // 清理舊的 font-size-mode 儲存
    localStorage.removeItem("font-size-mode");

    // ==========================================================================
    // 初始化變數
    // ==========================================================================
    const languageSelectIds = ["source-language", "target-language1", "target-language2", "target-language3"];
    elements = {
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
        textAlignmentSelector: document.getElementById("text-alignment-selector"),
        textTruncateModeSelector: document.getElementById("text-truncate-mode") // 新增
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
        const savedTextColor = localStorage.getItem(`${elements.optionSelector.value}-text-color`) || DEFAULT_SETTINGS[elements.optionSelector.value].textColor;
        elements.textColorPicker.value = savedTextColor;

        elements.textColorPicker.addEventListener("input", () => {
            updateSectionStyle("color", elements.textColorPicker.value);
            saveSettings({ textColor: elements.textColorPicker.value });
        });
    }

    if (elements.textStrokeColorPicker) {
        const savedStrokeColor = localStorage.getItem(`${elements.optionSelector.value}-text-stroke-color`) || DEFAULT_SETTINGS[elements.optionSelector.value].textStrokeColor;
        elements.textStrokeColorPicker.value = savedStrokeColor;

        elements.textStrokeColorPicker.addEventListener("input", () => {
            updateSectionStyle("--stroke-color", elements.textStrokeColorPicker.value);
            saveSettings({ textStrokeColor: elements.textStrokeColorPicker.value });
        });
    }

    if (elements.backgroundColorPicker) {
        const savedBgColor = localStorage.getItem("background-color") || DEFAULT_SETTINGS.backgroundColor;
        elements.backgroundColorPicker.value = savedBgColor;

        elements.backgroundColorPicker.addEventListener("input", () => {
            const color = elements.backgroundColorPicker.value;
            elements.rightPanel.style.backgroundColor = color;
            elements.section.style.backgroundColor = color;
            saveSettings({ backgroundColor: color });
        });
    }

    if (elements.fontSizeSlider) {
        const savedFontSize = parseFloat(localStorage.getItem(`${elements.optionSelector.value}-font-size`) || DEFAULT_SETTINGS[elements.optionSelector.value].fontSize);
        elements.fontSizeSlider.value = savedFontSize;

        elements.fontSizeSlider.addEventListener("input", () => {
            const fontSize = parseFloat(elements.fontSizeSlider.value);
            updateSectionStyle("fontSize", `${fontSize}px`, true);
            saveSettings({ fontSize: fontSize });
        });
    }

    if (elements.textStrokeSlider) {
        const savedStrokeSize = parseFloat(localStorage.getItem(`${elements.optionSelector.value}-text-stroke-size`) || DEFAULT_SETTINGS[elements.optionSelector.value].textStrokeSize);
        elements.textStrokeSlider.value = savedStrokeSize;

        elements.textStrokeSlider.addEventListener("input", () => {
            const strokeSize = parseFloat(elements.textStrokeSlider.value);
            updateSectionStyle("--stroke-width", `${strokeSize}px`);
            saveSettings({ textStrokeSize: strokeSize });
        });
    }

    // ==========================================================================
    // 文字截斷模式選擇器
    // ==========================================================================
	if (elements.textTruncateModeSelector) {
		const savedMode = localStorage.getItem("text-truncate-mode") || DEFAULT_SETTINGS.textTruncateMode;
		elements.textTruncateModeSelector.value = savedMode;
		updateTruncateModeClass(savedMode);
	
		elements.textTruncateModeSelector.addEventListener("change", () => {
			const mode = elements.textTruncateModeSelector.value;
			localStorage.setItem("text-truncate-mode", mode);
			updateTruncateModeClass(mode);
			console.info("[StyleController] Text truncate mode changed to:", mode);
		});
	}

    // ==========================================================================
    // 選項選擇器與設定載入
    // ==========================================================================
    if (elements.optionSelector) {
        const savedOption = localStorage.getItem("selected-option-language") || elements.optionSelector.value;
        elements.optionSelector.value = savedOption;
        localStorage.setItem("selected-option-language", savedOption);

        languageSelectIds.forEach(language => {
            loadSettings(language);
        });

        elements.optionSelector.addEventListener("change", () => {
            const language = elements.optionSelector.value;
            localStorage.setItem("selected-option-language", language);
            loadSettings(language);
            const settings = {
                fontSize: parseFloat(localStorage.getItem(`${language}-font-size`) || DEFAULT_SETTINGS[language].fontSize),
                textStrokeSize: parseFloat(localStorage.getItem(`${language}-text-stroke-size`) || DEFAULT_SETTINGS[language].textStrokeSize),
                textColor: localStorage.getItem(`${language}-text-color`) || DEFAULT_SETTINGS[language].textColor,
                textStrokeColor: localStorage.getItem(`${language}-text-stroke-color`) || DEFAULT_SETTINGS[language].textStrokeColor
            };
            if (elements.fontSizeSlider) elements.fontSizeSlider.value = settings.fontSize;
            if (elements.textStrokeSlider) elements.textStrokeSlider.value = settings.textStrokeSize;
            if (elements.textColorPicker) elements.textColorPicker.value = settings.textColor;
            if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = settings.textStrokeColor;
        });
    }

    // ==========================================================================
    // 文字對齊選單初始化與功能
    // ==========================================================================
    if (elements.textAlignmentSelector) {
        const savedAlignment = localStorage.getItem("text-alignment") || DEFAULT_SETTINGS.textAlignment;
        elements.textAlignmentSelector.value = savedAlignment;
        applyTextAlignment(savedAlignment);

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
			const validTargets = [
				elements.rightPanel,
				elements.rightPanel.querySelector(".scroll-container"),
				...elements.rightPanel.querySelectorAll(".text-overlay")
			];
			if (validTargets.includes(event.target)) {
				if (!isFullscreen) {
					document.querySelector(".left-panel").classList.add("hidden");
					elements.rightPanel.classList.add("fullscreen");
					document.body.classList.add("no-scroll");
					isFullscreen = true;
					console.log("Right panel switched to fullscreen mode.");
				} else {
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
            languageSelectIds.forEach(language => {
                const defaults = DEFAULT_SETTINGS[language];
                localStorage.setItem(`${language}-font-size`, defaults.fontSize);
                localStorage.setItem(`${language}-text-stroke-size`, defaults.textStrokeSize);
                localStorage.setItem(`${language}-text-color`, defaults.textColor);
                localStorage.setItem(`${language}-text-stroke-color`, defaults.textStrokeColor);
            });

            localStorage.setItem("background-color", DEFAULT_SETTINGS.backgroundColor);
            localStorage.setItem("text-alignment", DEFAULT_SETTINGS.textAlignment);
            localStorage.setItem("text-truncate-mode", DEFAULT_SETTINGS.textTruncateMode);

            const currentLanguage = elements.optionSelector.value;
            const currentDefaults = DEFAULT_SETTINGS[currentLanguage];
            if (elements.fontSizeSlider) elements.fontSizeSlider.value = currentDefaults.fontSize;
            if (elements.textStrokeSlider) elements.textStrokeSlider.value = currentDefaults.textStrokeSize;
            if (elements.textColorPicker) elements.textColorPicker.value = currentDefaults.textColor;
            if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = currentDefaults.textStrokeColor;
            if (elements.backgroundColorPicker) elements.backgroundColorPicker.value = DEFAULT_SETTINGS.backgroundColor;
            if (elements.textAlignmentSelector) elements.textAlignmentSelector.value = DEFAULT_SETTINGS.textAlignment;
            if (elements.textTruncateModeSelector) elements.textTruncateModeSelector.value = DEFAULT_SETTINGS.textTruncateMode;

            languageSelectIds.forEach(language => {
                loadSettings(language);
            });

            applyTextAlignment(DEFAULT_SETTINGS.textAlignment);

            console.log("Settings reset to defaults and all styles refreshed.");
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
        const savedFontSize = localStorage.getItem(`${language}-font-size`);
        const savedStrokeSize = localStorage.getItem(`${language}-text-stroke-size`);
        const settings = {
            fontSize: savedFontSize !== null ? Math.min(Math.max(parseFloat(savedFontSize), 10), 100) : defaults.fontSize,
            textStrokeSize: savedStrokeSize !== null ? Math.min(Math.max(parseFloat(savedStrokeSize), 0), 25) : defaults.textStrokeSize,
            textColor: localStorage.getItem(`${language}-text-color`) || defaults.textColor,
            textStrokeColor: localStorage.getItem(`${language}-text-stroke-color`) || defaults.textStrokeColor,
            backgroundColor: localStorage.getItem("background-color") || DEFAULT_SETTINGS.backgroundColor
        };

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

        if (elements.optionSelector.value === language) {
            if (elements.fontSizeSlider) elements.fontSizeSlider.value = settings.fontSize;
            if (elements.textStrokeSlider) elements.textStrokeSlider.value = settings.textStrokeSize;
            if (elements.textColorPicker) elements.textColorPicker.value = settings.textColor;
            if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = settings.textStrokeColor;
            if (elements.backgroundColorPicker) elements.backgroundColorPicker.value = settings.backgroundColor;
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
        refreshAllStyles();
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
                const savedFontSize = localStorage.getItem(`${lang}-font-size`);
                const savedStrokeSize = localStorage.getItem(`${lang}-text-stroke-size`);
                const settings = {
                    fontSize: savedFontSize !== null ? parseFloat(savedFontSize) : DEFAULT_SETTINGS[lang].fontSize,
                    textColor: localStorage.getItem(`${lang}-text-color`) || DEFAULT_SETTINGS[lang].textColor,
                    textStrokeSize: savedStrokeSize !== null ? parseFloat(savedStrokeSize) : DEFAULT_SETTINGS[lang].textStrokeSize,
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
			updateTruncateModeClass(localStorage.getItem("text-truncate-mode") || DEFAULT_SETTINGS.textTruncateMode);
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

	function updateTruncateModeClass(mode) {
		const scrollContainer = document.querySelector(".scroll-container");
		if (scrollContainer) {
			if (mode === "truncate") {
				scrollContainer.classList.add("truncate-mode");
			} else {
				scrollContainer.classList.remove("truncate-mode");
			}
		} else {
			console.error("[StyleController] Scroll container not found for truncate mode.");
		}
	}
});