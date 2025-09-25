// punctuation-ja.js
// 若使用 ESM 包裝：import kuromoji from './kuromoji-esm.js';
// 若用全域版本，改成：const kuromoji = window.kuromoji;
import kuromoji from './kuromoji-esm.js';

let DICT_PATH = '/kuromoji/dict'; // ← 修改為你的字典路徑
let _tokenizerPromise = null;

function getTokenizer() {
  if (!_tokenizerPromise) {
    _tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: DICT_PATH }).build((err, tokenizer) => {
        if (err) reject(err);
        else resolve(tokenizer);
      });
    });
  }
  return _tokenizerPromise;
}

export async function ensureTokenizerReady({ dicPath } = {}) {
  if (dicPath) DICT_PATH = dicPath;
  await getTokenizer();
}

/* ========== 基礎判斷工具 ========== */
const isTerminatorChar = ch => ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?';
const isCommaChar = ch => ch === '、';

const isPuncToken = t => t?.pos === '記号';
const isConjunction = t => t?.pos === '接続詞';
const isInterjection = t => t?.pos === '感動詞';
const isAdverb = t => t?.pos === '副詞' || (t?.pos === '名詞' && t?.pos_detail_1 === '副詞可能');
const isFinalParticle = t => t?.pos === '助詞' && t?.pos_detail_1 === '終助詞';
const isConjunctiveParticle = t => t?.pos === '助詞' && t?.pos_detail_1 === '接続助詞'; // ので/から/けど/が/て…
const isCaseParticle = t => t?.pos === '助詞' && t?.pos_detail_1 === '格助詞';
const isEnumeratingParticle = t => t?.pos === '助詞' && (t.surface_form === 'と' || t.surface_form === 'や' || t.surface_form === 'か' || t.surface_form === 'も');

const isNounLike = t => t?.pos === '名詞' || t?.pos === '代名詞';
const isVerb = t => t?.pos === '動詞';
const isAdj = t => t?.pos === '形容詞';
const isAux = t => t?.pos === '助動詞';

const isTeDe = t => t?.pos === '助詞' && (t.surface_form === 'て' || t.surface_form === 'で');

function atSentenceHead(out) {
  if (out.length === 0) return true;
  const ch = out[out.length - 1];
  return isTerminatorChar(ch);
}

function looksLikePredicateEnd(prev, curr, next) {
  if (!curr) return false;
  const form = curr.conjugation_form || '';
  // 動詞/形容詞 基本形/終止形
  if ((isVerb(curr) || isAdj(curr)) && (form.includes('基本形') || form.includes('終止形'))) return true;
  // 名詞 + 助動詞（だ/です/である/だった/でした…）
  if (prev && isNounLike(prev) && (isAux(curr) || (curr.pos === '名詞' && next && isAux(next)))) return true;
  return false;
}

/* ========== 數量詞短語偵測（不靠詞表） ==========
   模式： [数/記号(數字)/何] + [名詞-接尾] + { (名詞 | 助動詞) }*
   整段視為不可插逗 span
*/
function beginsNumericCounter(tokens, i) {
  const t0 = tokens[i], t1 = tokens[i+1];
  if (!t0 || !t1) return false;

  const numberLike =
    (t0.pos === '名詞' && t0.pos_detail_1 === '数') ||
    (t0.pos === '記号' && /^[0-9０-９]+$/.test(t0.surface_form)) ||
    (t0.surface_form === '何');

  const counterTail = (t1.pos === '名詞' && t1.pos_detail_1 === '接尾');
  return numberLike && counterTail;
}

function spanNumericCounter(tokens, i) {
  let end = i + 2; // [數/何][名詞-接尾] 已涵蓋
  while (end < tokens.length) {
    const t = tokens[end];
    if (t.pos === '名詞' || t.pos === '助動詞') {
      end++;
      continue;
    }
    break;
  }
  return end; // [i, end) 禁逗
}

/* ========== 列舉狀態 ========== */
function updateListRun(state, t) {
  if (isNounLike(t)) {
    state.listRunNounCount++;
    state.lastWasNoun = true;
  } else if (isEnumeratingParticle(t)) {
    state.lastWasNoun = false;
  } else {
    state.listRunNounCount = 0;
    state.lastWasNoun = false;
  }
}

/* ========== 感謝/道歉 定型語辨識（極小詞面 + POS） ========== */
function isGratitudeToken(t) {
  const sf = t?.surface_form || '';
  const bf = t?.basic_form || '';
  if (t?.pos === '感動詞' && (sf.includes('ありがとう') || bf.includes('ありがとう'))) return true;
  if (sf === 'ありがとう' || bf === 'ありがとう') return true;
  if (sf === 'ありがと' || bf === 'ありがと') return true;
  return false;
}

function isApologyToken(t) {
  const sf = t?.surface_form || '';
  const bf = t?.basic_form || '';
  if (sf.includes('すみません') || bf.includes('すみません')) return true;
  if (sf.includes('すいません') || bf.includes('すいません')) return true;
  if (sf.includes('申し訳') && (sf.includes('ない') || sf.includes('ありません') || bf.includes('ない'))) return true;
  if (sf.includes('失礼') && (sf.includes('しました') || bf.includes('する'))) return true;
  return false;
}

// 「ありがとうございます」黏著保護（避免切成「ありがとう、ございます」）
function isGozaimasuLike(t) {
  const sf = t?.surface_form || '';
  const bf = t?.basic_form || '';
  if (sf.includes('ございます') || bf.includes('ござる')) return true;
  if (sf === 'ござい' || bf.includes('ござる')) return true;
  if (sf === 'ます' || bf === 'ます') return true;
  return false;
}

/* ========== 主函式 ========== */
export async function addJapanesePunctuation(text, options = {}) {
  const {
    mode = 'safe',                  // 'none' | 'safe' | 'aggressive'
    enableLongRelativeComma = false,
    minEnumerateForComma = 3,
    dicPath,
  } = options;

  if (typeof text !== 'string' || text.length === 0) return text || '';

  // —— 前處理：修正常見輸入雜訊 —— //
  // 0) 半角逗號一律換全角，避免混用
  text = text.replace(/,/g, '、');
  // 1) 把奇怪的半角逗號標記統一（保險）
  text = text.replace(/([0-9０-９]+)､/g, '$1、');
  // 2) 數字 + 「、」+ 助數詞 → 去掉逗點（3、ヶ月 → 3ヶ月）
  text = text.replace(/([0-9０-９]+)、(ヶ?月|回|人|度|％|℃|歳|日|時間|分|秒)/g, '$1$2');
  // 3) ありがとう / ございます 的常見錯切合併
  text = text.replace(/ありがと、う/g, 'ありがとう');
  text = text.replace(/ござい、ます/g, 'ございます');

  if (dicPath) DICT_PATH = dicPath;
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(text);

  const out = [];
  const state = { listRunNounCount: 0, lastWasNoun: false };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // 原有記號直接保留（避免重複）
    if (isPuncToken(t)) {
      const last = out[out.length - 1];
      if (!(isCommaChar(last) && isCommaChar(t.surface_form))) out.push(t.surface_form);
      continue;
    }

    // 先輸出當前詞
    out.push(t.surface_form);

    // 列舉狀態
    updateListRun(state, t);

    // 句首（或句點後）：感動詞/接續詞/副詞 → 後加「、」
    if (mode !== 'none' && atSentenceHead(out.slice(0, -t.surface_form.length + 1))) {
      if (isInterjection(t) || isConjunction(t) || isAdverb(t)) {
        if (!isCommaChar(out[out.length - 1])) out.push('、');
      }
    }

    // 數量詞短語 span：在 [i, stop) 內禁逗（不特別 push 逗點即可）
    let numericStop = -1;
    if (beginsNumericCounter(tokens, i)) {
      numericStop = spanNumericCounter(tokens, i);
      // 這裡只是計算 span；插逗點時注意不要在 span 內加
    }

    // 接續助詞 → 子句邊界（但 て/で + 動詞/助動詞 為緊密結構）
    const inNumericSpan = (idx) => numericStop !== -1 && idx < numericStop;
    if (mode !== 'none' && isConjunctiveParticle(t) && !inNumericSpan(i)) {
      if (isTeDe(t)) {
        // 緊密結構：不加逗點
      } else {
        if (next && (isNounLike(next) || isVerb(next) || isAdj(next) || isAdverb(next) || isConjunction(next) || isInterjection(next))) {
          if (!isCommaChar(out[out.length - 1])) out.push('、');
        }
      }
    }

    // 列舉（≥ minEnumerateForComma）
    if (mode !== 'none' && state.listRunNounCount >= minEnumerateForComma && !inNumericSpan(i)) {
      if (isNounLike(t) && next && (isEnumeratingParticle(next) || isNounLike(next))) {
        const last = out[out.length - 1];
        if (!isCommaChar(last)) out.push('、');
      }
    }

    // （可選）長連體修飾 → 名詞前加「、」
    if (enableLongRelativeComma && isNounLike(t) && !inNumericSpan(i)) {
      let len = 0, hasVerbOrAdj = false;
      for (let j = i - 1; j >= 0 && len < 24; j--) {
        const tt = tokens[j];
        if (isPuncToken(tt) && isTerminatorChar(tt.surface_form)) break;
        len++;
        if (isVerb(tt) || isAdj(tt)) hasVerbOrAdj = true;
        if (isConjunction(tt) || isCaseParticle(tt)) break;
      }
      if (hasVerbOrAdj && len >= 12) {
        const insertIdx = out.length - t.surface_form.length;
        const prevCh = out[insertIdx - 1];
        if (!isCommaChar(prevCh)) out.splice(insertIdx, 0, '、');
      }
    }

    // —— 感謝/道歉 定型語處理 —— //
    // 黏著保護：ありがとう + ございます 之間不插逗
    if (isGratitudeToken(t) && next && isGozaimasuLike(next)) {
      // do nothing (避免之間插逗)
    }
    // 連續的感謝/道歉 → 中間加「、」
    if ((isGratitudeToken(t) || isApologyToken(t)) && next && (isGratitudeToken(next) || isApologyToken(next))) {
      if (!isCommaChar(out[out.length - 1])) out.push('、');
    }
    // 感謝/道歉 在句末或轉段前 → 收「。」
    if (isGratitudeToken(t) || isApologyToken(t)) {
      const nextStartsNewTurn = next && (isInterjection(next) || isConjunction(next));
      const nextIsTerm = next && next.pos === '記号' && isTerminatorChar(next.surface_form);
      if (!next || nextStartsNewTurn || nextIsTerm) {
        const lastCh = out[out.length - 1];
        if (!isTerminatorChar(lastCh)) out.push('。');
      }
    }

    // 句末補句點（保守）
    const atEnd = (i === tokens.length - 1);
    if (atEnd) {
      const lastCh = out[out.length - 1];
      if (!isTerminatorChar(lastCh)) {
        if (looksLikePredicateEnd(tokens[i - 1], t, next) || isFinalParticle(t)) {
          out.push('。');
        } else {
          out.push('。');
        }
      }
    }
  }

  // 清理重複逗點
  for (let k = out.length - 2; k >= 0; k--) {
    if (out[k] === '、' && out[k + 1] === '、') out.splice(k + 1, 1);
  }

  return out.join('');
}
