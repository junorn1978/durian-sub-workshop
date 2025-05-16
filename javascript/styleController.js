// ==========================================================================
// 全局預設值與語言清單
// ==========================================================================
const SELECTORS = {
    scrollContainer: '.scroll-container',
    textOverlay: '.text-overlay',
    sourceText: '.source-text',
    targetText1: '.target-text-1',
    targetText2: '.target-text-2',
    targetText3: '.target-text-3',
    rightPanel: '.right-panel',
    leftPanel: '.left-panel'
};

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
    textTruncateMode: "truncate"
};

const LANGUAGE_OPTIONS = [
    { value: "ja", label: "日本語" },
    { value: "zh-TW", label: "繁體字(台湾)" },
    { value: "en", label: "英語" },
    { value: "es", label: "スペイン語" },
    { value: "id", label: "インドネシア語" }
];

// ==========================================================================
// 輔助函數
// ==========================================================================
let elements = {};
const languageToSpanMap = {
    "source-language": SELECTORS.sourceText,
    "target-language1": SELECTORS.targetText1,
    "target-language2": SELECTORS.targetText2,
    "target-language3": SELECTORS.targetText3
};


document.addEventListener("DOMContentLoaded", () => {
    localStorage.removeItem("font-size-mode");

	// ==========================================================================
	// 初始化變數
	// ==========================================================================
	const languageSelectIds = ["source-language", "target-language1", "target-language2", "target-language3"];
	const ELEMENT_IDS = {
		apiKeyInput: "api-key-input",
		apiKeyValue: "api-key-value",
		toggleVisibilityUrl: "toggle-visibility-url",
		toggleVisibilityKey: "toggle-visibility-key",
		startSpeechButton: "start-recording",
		stopSpeechButton: "stop-recording",
		optionSelector: "option-language-selector",
		fontSizeSlider: "font-size-slider",
		textStrokeSlider: "text-stroke-slider",
		textColorPicker: "text-color-picker",
		textStrokeColorPicker: "text-stroke-color-picker",
		backgroundColorPicker: "background-color-picker",
		rightPanel: null,
		leftPanel: null,
		section: "section-1",
		textAlignmentSelector: "text-alignment-selector",
		textTruncateModeSelector: "text-truncate-mode"
	};
	
	const elements = Object.entries(ELEMENT_IDS).reduce((obj, [key, id]) => {
		if (id) {
			obj[key] = document.getElementById(id);
			if (!obj[key]) console.warn(`Element not found: #${id}`);
		}
		return obj;
	}, {});
	
	elements.rightPanel = document.querySelector(SELECTORS.rightPanel);
	if (!elements.rightPanel) console.warn(`Element not found: ${SELECTORS.rightPanel}`);
	elements.leftPanel = document.querySelector(SELECTORS.leftPanel);
	if (!elements.leftPanel) console.warn(`Element not found: ${SELECTORS.leftPanel}`);

    // ==========================================================================
    // 動態生成語言選擇器選項
    // ==========================================================================
    languageSelectIds.forEach(id => {
        const selectElement = document.getElementById(id);
        if (!selectElement) {
            return console.error(`Language select not found: ${id}`);
        }

        const prefix = id === "source-language" ? "來源 - " : `言語${id.slice(-1)} - `;
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
    bindPasswordInput(elements.apiKeyInput, elements.toggleVisibilityUrl, 'api-key-input');
    bindPasswordInput(elements.apiKeyValue, elements.toggleVisibilityKey, 'api-key-value');

    // ==========================================================================
    // 樣式控制功能
    // ==========================================================================
    bindColorPicker(elements.textColorPicker, "text-color", (value) => updateSectionStyle("color", value));
    bindColorPicker(elements.textStrokeColorPicker, "stroke-color", (value) => updateSectionStyle("--stroke-color", value));
    bindColorPicker(elements.backgroundColorPicker, "background-color", (value) => {
        elements.rightPanel.style.backgroundColor = value;
        elements.section.style.backgroundColor = value;
    }, false, true);

    bindSlider(elements.fontSizeSlider, "font-size", "fontSize", true);
    bindSlider(elements.textStrokeSlider, "stroke-size", "--stroke-width");

    // ==========================================================================
    // 文字截斷模式選擇器
    // ==========================================================================
	if (elements.textTruncateModeSelector) {
		const savedMode = localStorage.getItem("text-truncate-mode") || DEFAULT_SETTINGS.textTruncateMode;
		elements.textTruncateModeSelector.value = savedMode;
		updateTruncateModeClass(savedMode);
	
		elements.textTruncateModeSelector.addEventListener("change", e => {
			const mode = e.target.value;
			localStorage.setItem("text-truncate-mode", mode);
			updateTruncateModeClass(mode);
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
	
		elements.optionSelector.addEventListener("change", e => {
			const language = e.target.value;
			localStorage.setItem("selected-option-language", language);
			loadSettings(language);
		});
	}

    // ==========================================================================
    // 文字對齊選單初始化與功能
    // ==========================================================================
	if (elements.textAlignmentSelector) {
		const savedAlignment = localStorage.getItem("text-alignment") || DEFAULT_SETTINGS.textAlignment;
		elements.textAlignmentSelector.value = savedAlignment;
		applyTextAlignment(savedAlignment);
	
		elements.textAlignmentSelector.addEventListener("change", e => {
			const alignment = e.target.value;
			localStorage.setItem("text-alignment", alignment);
			applyTextAlignment(alignment);
		});
	}

    // ==========================================================================
    // 全螢幕切換功能（無翻頁效果）
    // ==========================================================================
	if (elements.rightPanel) {
		elements.rightPanel.addEventListener("click", (e) => {
			if (elements.rightPanel.contains(e.target)) toggleFullscreen();
		});
	}

    // ==========================================================================
    // 恢復預設值按鈕
    // ==========================================================================
	const resetButton = document.getElementById("reset-settings");
	if (resetButton) {
		resetButton.addEventListener("click", resetAllSettings);
	}

    // ==========================================================================
    // 輔助函數
    // ==========================================================================
	function toggleFullscreen() {
    const isFs = elements.rightPanel.classList.toggle("fullscreen");
    elements.leftPanel.classList.toggle("hidden", isFs);
    document.body.classList.toggle("no-scroll", isFs);
	}
	
	function resetAllSettings() {
    languageSelectIds.forEach(lang => {
        const defs = DEFAULT_SETTINGS[lang];
        localStorage.setItem(`${lang}-font-size`, defs.fontSize);
        localStorage.setItem(`${lang}-stroke-size`, defs.textStrokeSize);
        localStorage.setItem(`${lang}-text-color`, defs.textColor);
        localStorage.setItem(`${lang}-stroke-color`, defs.textStrokeColor);
    });

    localStorage.setItem("background-color", DEFAULT_SETTINGS.backgroundColor);
    localStorage.setItem("text-alignment", DEFAULT_SETTINGS.textAlignment);
    localStorage.setItem("text-truncate-mode", DEFAULT_SETTINGS.textTruncateMode);

    const current = elements.optionSelector.value;
    loadSettings(current);

    applyTextAlignment(DEFAULT_SETTINGS.textAlignment);
    updateTruncateModeClass(DEFAULT_SETTINGS.textTruncateMode);
    refreshAllStyles();
	}
	
    function bindPasswordInput(inputElement, toggleElement, key) {
        if (!inputElement || !toggleElement) {
            console.error(`[StyleController] Invalid input or toggle element for ${key}`);
            return;
        }
        const saved = localStorage.getItem(key);
        if (saved) inputElement.value = saved;

        inputElement.addEventListener('input', () => {
            localStorage.setItem(key, inputElement.value);
        });

        toggleElement.addEventListener('click', () => {
            const isPassword = inputElement.type === 'password';
            inputElement.type = isPassword ? 'text' : 'password';
            toggleElement.classList.toggle('visible', isPassword);
        });
    }

    function bindColorPicker(element, key, updateCallback, isLangSpecific = true, isGlobal = false) {
        if (!element) {
            console.error(`[StyleController] Invalid element for ${key}`);
            return;
        }
        element.addEventListener("input", () => {
            const lang = isLangSpecific ? elements.optionSelector.value : "";
            updateCallback(element.value);
            saveSettings({ [key]: element.value });
        });
    }

    function bindSlider(element, key, cssProperty, isSectionLevel = false) {
        if (!element) {
            console.error(`[StyleController] Invalid element for ${key}`);
            return;
        }
        element.addEventListener("input", () => {
            const value = parseFloat(element.value);
            const lang = elements.optionSelector.value;
            updateSectionStyle(cssProperty, `${value}px`, isSectionLevel);
            saveSettings({ [key]: value });
        });
    }

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

	// ==========================================================================
	// 輔助函數
	// ==========================================================================
	function getNumericSetting(key, defaultVal, min, max) {
		const raw = localStorage.getItem(key);
		if (raw === null) return defaultVal;
		const n = parseFloat(raw);
		return isNaN(n) ? defaultVal : Math.min(Math.max(n, min), max);
	}
	
	function applySpanSettings(span, { fontSize, textColor, textStrokeSize, textStrokeColor }) {
		span.style.fontSize = `${fontSize}px`;
		span.style.color = textColor;
		span.style.setProperty("--stroke-width", `${textStrokeSize}px`);
		span.style.setProperty("--stroke-color", textStrokeColor);
		if (span.getAttribute("data-stroke") !== span.textContent) {
			span.setAttribute("data-stroke", span.textContent);
		}
	}
	
	function applyControlValues(settings, language) {
		if (elements.optionSelector.value !== language) return;
		const { fontSize, textStrokeSize, textColor, textStrokeColor, backgroundColor } = settings;
		if (elements.fontSizeSlider) elements.fontSizeSlider.value = fontSize;
		if (elements.textStrokeSlider) elements.textStrokeSlider.value = textStrokeSize;
		if (elements.textColorPicker) elements.textColorPicker.value = textColor;
		if (elements.textStrokeColorPicker) elements.textStrokeColorPicker.value = textStrokeColor;
		if (elements.backgroundColorPicker) elements.backgroundColorPicker.value = backgroundColor;
	}
	
	function loadSettings(language) {
		const defaults = DEFAULT_SETTINGS[language];
		const settings = {
			fontSize: getNumericSetting(`${language}-font-size`, defaults.fontSize, 10, 100),
			textStrokeSize: getNumericSetting(`${language}-stroke-size`, defaults.textStrokeSize, 0, 25),
			textColor: localStorage.getItem(`${language}-text-color`) || defaults.textColor,
			textStrokeColor: localStorage.getItem(`${language}-stroke-color`) || defaults.textStrokeColor,
			backgroundColor: localStorage.getItem("background-color") || DEFAULT_SETTINGS.backgroundColor
		};
	
		const span = elements.section.querySelector(languageToSpanMap[language]);
		if (span) applySpanSettings(span, settings);
	
		if (elements.rightPanel && elements.section) {
			elements.rightPanel.style.backgroundColor = settings.backgroundColor;
			elements.section.style.backgroundColor = settings.backgroundColor;
		}
	
		applyControlValues(settings, language);
	}

    function saveSettings(settings) {
        const language = elements.optionSelector.value;
        Object.entries(settings).forEach(([key, value]) => {
            if (key === "background-color") {
                localStorage.setItem(key, value);
            } else {
                localStorage.setItem(`${language}-${key}`, value);
            }
        });
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
                const savedStrokeSize = localStorage.getItem(`${lang}-stroke-size`);
                const settings = {
                    fontSize: savedFontSize !== null ? parseFloat(savedFontSize) : DEFAULT_SETTINGS[lang].fontSize,
                    textColor: localStorage.getItem(`${lang}-text-color`) || DEFAULT_SETTINGS[lang].textColor,
                    textStrokeSize: savedStrokeSize !== null ? parseFloat(savedStrokeSize) : DEFAULT_SETTINGS[lang].textStrokeSize,
                    textStrokeColor: localStorage.getItem(`${lang}-stroke-color`) || DEFAULT_SETTINGS[lang].textStrokeColor
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
		const scrollContainer = elements.section.querySelector(SELECTORS.scrollContainer);
		if (scrollContainer) {
			scrollContainer.style.textAlign = alignment;
		} else {
			console.error(`Scroll container not found: ${SELECTORS.scrollContainer}`);
		}
	}

	function updateTruncateModeClass(mode) {
		const scrollContainer = document.querySelector(SELECTORS.scrollContainer);
		if (scrollContainer) {
			if (mode === "truncate") {
				scrollContainer.classList.add("truncate-mode");
			} else {
				scrollContainer.classList.remove("truncate-mode");
			}
		} else {
			console.error(`Scroll container not found: ${SELECTORS.scrollContainer}`);
		}
	}
});