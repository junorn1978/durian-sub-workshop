/**
 * @file normalizeJa.js
 * @description Chrome 本地端 (SODA) 日文模型會在每個 token 之間插入空白，
 * 此模組負責把那些空白接回去。
 *
 * 日文本來就不用空白分詞，但本地端模型會在 interim 逐音節輸出
 * (「お は よ う」)、final 逐詞素輸出 (「それ は そう。」)。
 * 這些空白若不處理會直接流進字幕，並且讓 Ray Mode 關鍵字規則整組失效
 * ——規則是以正常日文書寫的 (例：ククちゃん)，永遠不會命中「ク ク ち ゃ ん」。
 *
 * 只在「空白至少有一側是日文字元」時才刪除，夾雜的拉丁字母片語會保留原本的空白：
 * 「Apex Legends の 話」→「Apex Legendsの話」，而不是「ApexLegendsの話」。
 *
 * 判斷依據是語言而非 processLocally：雲端辨識不會產生這些空白，對雲端來說是 no-op，
 * 這樣即使在同一場辨識中默默 fallback 到另一條路徑也不會漏掉。
 */

/* 書寫時不需要前後空白的字元區塊：
   CJK 標點與々 (3000-303F)、平假名 (3040-309F)、片假名含長音符ー (30A0-30FF)、
   漢字擴充 A (3400-4DBF) 與基本區 (4E00-9FFF)、全形符號 (FF01-FF60)、半形片假名 (FF66-FF9F)。 */
const JA_CHARS =
  '\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uFF01-\\uFF60\\uFF66-\\uFF9F';

/* 任一側碰到日文字元的空白。刻意寫成兩個分支而非 lookbehind + lookahead 成對，
   這樣字串最開頭與最結尾的空白也會被清掉。 */
const JA_ADJACENT_SPACE = new RegExp(`(?<=[${JA_CHARS}])\\s+|\\s+(?=[${JA_CHARS}])`, 'g');

/**
 * 把日文辨識結果中的分詞空白接回去。
 * @param {string} text - 已由呼叫端做過標點正規化的辨識文字
 * @returns {string}
 */
export function joinJapaneseSpaces(text) {
  if (!text) return text ?? '';
  return text
    .replace(/\s+/g, ' ')          /* 先把連續空白壓成一個，後面掃一次就夠 */
    .replace(JA_ADJACENT_SPACE, '')
    .trim();
}

/**
 * 辨識流程用的語言判斷包裝：日文才處理，其他語言原樣通過。
 * @param {string} text - 辨識文字
 * @param {string} [lang] - 辨識語言的 BCP 47 標籤 (例：'ja-JP')
 * @returns {string}
 */
export function normalizeRecognised(text, lang) {
  if (!lang || !String(lang).toLowerCase().startsWith('ja')) return text ?? '';
  return joinJapaneseSpaces(text);
}
