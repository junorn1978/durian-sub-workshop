# ハムハム字幕アトリエ — 架構與檔案用途（給 AI 溝通用）

說明目的：協助人類與 AI 迅速理解本專案的資料流、模組邏輯與各檔案的責任邊界，方便提出精準修改建議。

## 目錄
1. 整體資料流（口語 → 字幕）
2. 模組與檔案職責
3. 設定與資料檔
4. 與 AI 溝通應提供的關鍵資訊
5. 常見修改入口（給 AI 的工作切入點）
6. 相容性與日誌規範
7. 變更影響評估清單

---

## 整體資料流（口語 → 字幕）

1. **語音擷取**：`speechCapture.js` 建立並管理 SpeechRecognition，依瀏覽器（Chrome/Edge）與本地模型可用性決定 continuous 與處理策略，同步更新「來源字幕」。
   - **（可選）RayMode 前處理**：載入 `ray_mode_keywords.json`，對輸入語句進行輕量替換或過濾，降低誤聽造成的可讀性問題。
   - **（可選）Deepgram**：`deepgramService.js` 從 Web Speech API 改走使用 `getUserMedia` 傳送音訊至 Deepgram 伺服器進行辨識後回傳轉文字結果。

2. **翻譯管線分流**：`translationController.js` 的 `sendTranslationRequest()` 依 UI 狀態與可用性決策路徑：
   - **本地 Translator API**：`translatorApiService.js`
   - **本地 Prompt API（小型模型）**：`promptTranslationService.js`
   - **遠端翻譯（GAS / 自架服務）**：`remoteTranslationService.js`

3. **顯示與排序**：以 `sequenceId`、緩衝區與 `minDisplayTime` 控制三路目標語言字幕的顯示順序與停留時間。

4. **語言/顯示規則**：由 `config.js` 讀取 `language_config.json`（含 chunkSize、displayTimeRules、代碼映射），供各模組查詢。

---

## 模組與檔案職責

### 1) speechCapture.js（語音擷取與前處理）
- 建立 SpeechRecognition、監聽 onresult/onend/onerror，處理 Chrome/Edge 差異與自動重啟。
- 即時更新來源字幕（臨時＋最終結果）。
- **RayMode**：載入關鍵字表，對輸入字串進行替換與過濾。
- 向 `translationController.sendTranslationRequest()` 傳遞最終結果以進入翻譯管線。

### 2) translationController.js（翻譯與顯示總控）
- 佇列與並發節流（例如 MAX=5）、`sequenceId` 排程與顯示緩衝。
- 決策三條翻譯路徑：Prompt API / Translator API / 遠端服務。
- `updateTranslationUI()`：依語言規則（chunkSize、displayTimeRules）與序列排序刷新三路字幕。

### 3) translatorApiService.js（本地 Translator API）
- 檢查並預下載模型（來源語言＋目標語言）。
- 管理 Translator 實例快取、回報下載進度與錯誤。
- `sendLocalTranslation()`：走本地翻譯，結果回寫 UI。

### 4) promptTranslationService.js（本地 Prompt API）
- 管理 LanguageModel 工作階段池（依 targetLang 與抽樣參數分桶；閒置回收）。
- `sendPromptTranslation()`：並行處理多目標語言翻譯；含必要重試與錯誤回報。
- `setupPromptModelDownload()`：模型預下載與進度顯示。

### 5) remoteTranslationService.js（遠端翻譯）
- **GAS**：支援 `GAS://<SCRIPT_ID>` → 轉為 GET 執行端點並帶參數（含長度防護）。
- **自架/雲端**：`POST /translate`；可用 `apikey://host` 形式於第一次輸入時抽取並保存 API Key。
- `processTranslationUrl()`：依 URL 自動選擇通道與錯誤處理。

### 6) config.js（語言設定中心）
- 載入 `language_config.json`，並提供查詢 API：
  - `loadLanguageConfig()`, `getAllLanguages()`, `getLangById()`
  - `getTargetCodeById()`, `getTargetCodeForTranslator()`
  - `getPromptApiCode()`, `getLanguageModelApiCode()`
  - `getChunkSize()`, `getDisplayTimeRules()`

### 7) languagePackManager.js（本地語音辨識語言包）
- 查詢/下載/安裝 SpeechRecognition 語言包，更新 UI 可用狀態。

### 8) uiController.js（UI 初始化與偏好）
- 初始化語言下拉清單、樣式與行為設定（顏色/字級/描邊/對齊/溢出），並保存至 localStorage。
- Edge 限制提示與面板切換、縮小控制面板動作。

---

## 設定與資料檔

### language_config.json
- 每個語言含以下欄位（示意）：
  - `id`, `label`, `asSource`, `asTarget`
  - `chunkSize`（字幕分塊大小）
  - `displayTimeRules`（顯示時間控制）
  - `targetCodeMap`（遠端/本地 API 需要的語言代碼）
  - `promptApiCode`, `languageModelApiCode`
- 另有 `defaults` 供未命中語言時 fallback。

### ray_mode_keywords.json
- 依語言分組的替換規則陣列：`{ pattern: "...", replace: "..." }`
- 用於 RayMode 的誤聽修正與表達統一。

---

## 與 AI 溝通應提供的關鍵資訊
以下要點能讓 AI 快速定位並避免無效修改：
1. **你打算修改哪條翻譯路徑？**（Prompt / Translator / 遠端）
   - 若是遠端：提供目前的服務 URL（或 `GAS://<SCRIPT_ID>`）與限制。
2. **涉及哪些語言與顯示規則？** 指出要改 `language_config.json` 的哪些語言、哪些欄位（chunkSize/displayTimeRules/代碼映射）。
3. **UI 期望行為**：說明是要變更顯示排序、停留時間、或關於臨時結果/最終結果的呈現方式。
4. **瀏覽器環境**：Chrome 或 Edge（僅考慮 v139 系列），是否允許本地模型下載。
5. **日誌觀測**：提供出現的 `console.debug/info/error` 片段，便於 AI 追蹤路徑與狀態。

---

## 常見修改入口（給 AI 的工作切入點）
- **調整字幕停留/分塊**：編輯 `language_config.json` 中目標語言的 `displayTimeRules` 與 `chunkSize`。
- **新增或改寫翻譯後端**：在 `remoteTranslationService.js` 新增一個路由分支與錯誤處理；於 `translationController.js` 增加分流判斷。
- **本地模型行為**：
  - **Translator**：調整 `translatorApiService.js` 的模型預載策略與 `ensureModelLoaded()` 回報。
  - **Prompt**：調整 `promptTranslationService.js` 的 session 池策略（閒置回收、最大並行量、重試退避）。
- **RayMode 微調**：更新 `ray_mode_keywords.json` 規則；必要時在 `speechCapture.js` 擴充前處理流程。
- **語音連續性/自動重啟**：在 `speechCapture.js` 調整 continuous 與看門狗/超時策略（Chrome 與 Edge 分流）。

---

## 相容性與日誌規範
- **瀏覽器相容性**：僅考慮 Chrome / Edge v145；不支援行動裝置與其他瀏覽器。
- **Console 日誌格式**（請維持以下規範，利於問題回報與 AI 追蹤）：
  - 資訊：`console.info("[INFO]", "[檔名]", "描述", 其他參數...)`
  - 除錯：`console.debug("[DEBUG]", "[檔名]", "中文描述", errorOrData)`
  - 錯誤：`console.error("[ERROR]", "[檔名]", "中文描述", error)`

---

## 變更影響評估清單
在提出 PR 或請 AI 產生修改前，請自檢以下項目：
- 函式名稱是否沿用（避免跨檔案呼叫失配）。
- 語言代碼映射是否一致（`targetCodeMap`/`promptApiCode`/`languageModelApiCode`）。
- 顯示邏輯：`sequenceId`、緩衝上限、`minDisplayTime` 是否需要同步調整。
- 異常與重試策略：遠端逾時、Prompt/Translator 模型未就緒、網路錯誤時的 UI 提示是否覆蓋。
- Edge 限制：若功能僅在 Chrome 可用，UI 是否已禁用或顯示說明。