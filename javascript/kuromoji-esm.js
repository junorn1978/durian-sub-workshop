// kuromoji-esm.js
import './kuromoji.js'; // 先把 UMD 檔跑起來，會掛在 window
export default window.kuromoji;        // 導出成 ESM 的 default