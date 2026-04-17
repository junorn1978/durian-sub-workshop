# CLAUDE.md

## Project Overview

**ハムハム字幕アトリエ** — Browser-based real-time speech-to-text + translation subtitle tool for live streaming. Captures mic audio, transcribes, translates into up to 3 languages simultaneously, displays subtitles in-browser and via OBS overlay.

- Pure vanilla JS (ES6 modules, no frameworks/bundlers/npm)
- Chrome / Edge v145+ only
- UI and comments: Traditional Chinese + Japanese mix
- Deployed via GitHub Pages: https://junorn1978.github.io/durian-sub-workshop/

## Local Development

No build step. Serve and open in Chrome:

```bash
python -m http.server 8081
# Open http://localhost:8081/index.html
```

Windows `.bat` files launch Python server + Chrome Dev with `--enable-features=AIPromptAPI`.

No tests, no linter, no CI.

## Core Data Flow

```
Microphone → speechCapture.js (Web Speech API or Deepgram)
         → [optional] rayModeFilter.js (keyword correction)
         → translationController.js (queue + routing)
              ├─ gtxTranslationService.js      (Google Translate, default)
              ├─ translatorApiService.js        (Chrome Translator API, local)
              ├─ promptTranslationService.js    (Browser AI LanguageModel, experimental)
              └─ remoteTranslationService.js    (GAS or custom backend)
         → UI display (uiState.js) + OBS overlay (obsBridge.js)
```

## Key Modules to Know

| Module | Why it matters |
|--------|---------------|
| `translationController.js` | Central orchestrator: request queue (max 5 concurrent), `sequenceId` ordering, display buffer, service routing |
| `uiState.js` | Shared DOM utilities — extracted specifically to break circular deps (see below) |
| `uiController.js` | UI init, event bindings, localStorage persistence |
| `config.js` | Loads `data/language_config.json`; provides language code lookups, chunkSize, displayTimeRules |
| `obsBridge.js` | OBS WebSocket v5: auto-setup text sources, subtitle publishing |

## HTML Entry Points

- `index.html` — Main control panel
- `obs_overlay.html` — OBS browser source (`#mode=source|target1|target2|target3`)

## Console Logging Convention

All logs: `console.{info|debug|error}("[LEVEL]", "[fileName]", "description", data)`

## Architecture Warnings

1. **Circular dependencies:** v2.15.2 refactored to break circular imports. `uiState.js` is the shared DOM layer between speech, translation, and UI modules. **Do not reintroduce circular imports.**

2. **Translation concurrency:** `translationController.js` caps at 5 in-flight requests with a queue. Display uses `sequenceId` to prevent out-of-order rendering. Don't bypass the queue.

3. **Browser feature detection is critical:** Chrome Translator API, LanguageModel API, and on-device speech packs are experimental and may be unavailable. Always feature-detect.

4. **OBS auth:** obs-websocket v5 with SHA256 challenge-response. Auto-setup programmatically creates text sources.

## Change Impact Checklist

Before modifying code, verify:
- Function names haven't changed across module boundaries
- Language code mappings are consistent (`targetCodeMap` / `promptApiCode` / `languageModelApiCode`)
- Display logic (`sequenceId`, buffer limits, `minDisplayTime`) stays in sync
- Error/retry paths provide appropriate UI feedback
- Edge-only limitations are reflected in UI