<div align="center">
  <a href="./README_EN.md">English</a> | <a href="./README_JP.md">日本語</a> | <b>繁體中文</b>
</div>

# ハムハム字幕アトリエ

本軟體為 Vtuber [乙夏れい](https://www.youtube.com/@OtsukaRay) 所製作。
- (但除了乙夏れいさん專用過濾文字以外，其他功能皆可任意使用。)
- 主要功能為將語音即時轉為文字逐字顯示，並進行即時翻譯。透過 OBS 擷取視窗，即可在直播畫面上呈現翻譯字幕的效果。


## 功能介紹

### 語音辨識 (Speech Recognition)
支援以下辨識方式：
- **Web Speech API**：瀏覽器內建API(預設，免費)。
- **Deepgram**：專業語音辨識服務商（需付費）。
  - 新帳號註冊通常提供 $200 美金額度。
  - 費用約為每小時 $1 美金左右。

### 翻譯功能 (Translation)
支援以下翻譯方式：
- **自訂連結**：可自行製作後端串接，符合特定格式即可使用。
- **Google (GAS) 翻譯**：利用 Google Apps Script 內建的免費翻譯 API。(每日5000句額度限定)
- **瀏覽器內建翻譯 API**：利用瀏覽器的新型翻譯 API 進行翻譯。(顯示速度快，但準確性尚待提升)
- **瀏覽器內建 AI**：利用瀏覽器內建的 AI 模型進行翻譯。 (目前處於實驗階段尚未開放)

### 支援瀏覽器
- **Chrome**：V145 以上
- **Edge**：V145 以上

### 使用方式
請直接訪問網頁：[https://junorn1978.github.io/durian-sub-workshop/](https://junorn1978.github.io/durian-sub-workshop/)

**基本設定步驟：**
1. **設定語音來源**：請將「聲音認識」設定為您主要使用的語言（例如：日本語）。
2. **設定翻譯目標**：選擇您希望翻譯成的語言（例如：英語）。
3. **選擇翻譯模式**：請依照需求選擇合適的「翻譯モード」。

**模式說明：**
- **Cloud 模式**：選擇後，旁邊會出現 `?` 按鈕，點擊即可查看詳細使用說明。
- **高速翻譯模式**：選擇後，旁邊會出現下載按鈕。首次使用請點選下載，完成後需**重新整理網頁**方可生效。


**操作建議：**
建議將網頁以「獨立視窗」開啟使用。若有需要，可利用 Windows 11 的 APP 模式，或下載以下 BAT 檔案執行（將自動以獨立視窗開啟）：

- **快速啟動 BAT 下載**：
  - [Chrome 專用版](https://junorn1978.github.io/durian-sub-workshop/%E3%83%8F%E3%83%A0%E3%83%8F%E3%83%A0%E5%AD%97%E5%B9%95%E3%82%A2%E3%83%88%E3%83%AA%E3%82%A8_translate%20-%20github%20-%20chrome.bat)
  - [Edge 專用版](https://junorn1978.github.io/durian-sub-workshop/%E3%83%8F%E3%83%A0%E3%83%8F%E3%83%A0%E5%AD%97%E5%B9%95%E3%82%A2%E3%83%88%E3%83%AA%E3%82%A8_translate%20-%20github%20-%20edge.bat)


### 進階使用者 (Advanced)
若您希望使用自架的翻譯 API（例如：TranslationGemma），只需確保您的後端服務符合以下接收格式即可串接。

**請求方式 (Request):**
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Header (Optional)**: `X-API-Key: <Your-API-Key>` (若 URL 包含 `key://` 協議會自動帶入)

**請求內容 (Payload):**
```json
{
  "text": "要翻譯的文字",
  "targetLangs": ["en", "ja"],
  "sourceLang": "zh-TW",
  "sequenceId": 123,
  "previousText": "上一句翻譯的文字(可選)"
}
```
