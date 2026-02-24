<div align="center">
  <b>English</b> | <a href="./README_JP.md">日本語</a> | <a href="./README.md">繁體中文</a>
</div>

# HamuHamu Subtitle Atelier

A real-time subtitle + translation overlay tool originally made for VTuber [Otsuka Ray](https://www.youtube.com/@OtsukaRay).

- Anyone can use it freely (all features are available to everyone, except the Otsuka Ray–specific filtering).
- It transcribes speech in real time and translates it instantly.
- Capture the app window in OBS to display translated subtitles on your livestream.

---

## Features

### Speech Recognition
Recognition options:
- **Web Speech API**: Built into the browser (default, free).
- **Deepgram**: Professional speech recognition service (paid).
  - New accounts often receive around **$200** in credits.
  - Estimated cost: **~$1 USD / hour**

### Translation
Translation options:
- **Custom Link**: Connect your own backend (usable if it matches the required request format).
- **Google (GAS) Translation**: Uses Google Apps Script’s built-in translation API (limit: **5000 sentences/day**).
- **Browser Built-in Translation API**: Uses the browser’s new translation API (very fast, accuracy is still improving).
- **Browser Built-in AI**: Uses the browser’s built-in AI model (experimental; not yet available—will be enabled once stable).

---

### Supported Browsers
- **Chrome**: v145 or later
- **Edge**: v145 or later

---

### Usage

Open the web app here:  
https://junorn1978.github.io/durian-sub-workshop/

### Basic setup
1. **Speech language**: Set “Speech Recognition” to the main language you speak (e.g., Japanese).
2. **Target language**: Choose the language you want to translate into (e.g., English).
3. **Translation mode**: Pick a “Translation Mode” that fits your use case.

### Mode notes
- **Cloud Mode**: A `?` button will appear next to it—click to view detailed instructions.
- **High-Speed Translation Mode**: A download button will appear. Download once for the first use, then **refresh the page** to apply.

### Tip: use a separate window
For the best experience, open the web app in a **separate/standalone window**.  
You can use Windows 11 “App mode”, or download and run the BAT files below (they will open the app in a separate window automatically):

- **Quick Start BAT**:
  - [Chrome version](https://junorn1978.github.io/durian-sub-workshop/%E3%83%8F%E3%83%A0%E3%83%8F%E3%83%A0%E5%AD%97%E5%B9%95%E3%82%A2%E3%83%88%E3%83%AA%E3%82%A8_translate%20-%20github%20-%20chrome.bat)
  - [Edge version](https://junorn1978.github.io/durian-sub-workshop/%E3%83%8F%E3%83%A0%E3%83%8F%E3%83%A0%E5%AD%97%E5%B9%95%E3%82%A2%E3%83%88%E3%83%AA%E3%82%A8_translate%20-%20github%20-%20edge.bat)

---

## Advanced (Custom translation backend)

If you want to use a self-hosted translation API (e.g., TranslationGemma), you can connect it as long as your backend supports the request format below.

### Request
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Header (Optional)**: `X-API-Key: <Your-API-Key>`  
  (Automatically included if the URL contains the `key://` protocol)

### Payload example
```json
{
  "text": "Text to translate",
  "targetLangs": ["en", "ja"],
  "sourceLang": "zh-TW",
  "sequenceId": 123,
  "previousText": "Previous context text (optional)"
}
```