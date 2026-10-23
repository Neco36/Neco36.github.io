// 形態素解析（kuromoji.js）でふりがなを付ける。
// プログラムは CDN から、辞書（約 18MB）はページと一緒に公開した dict/ から読み込む。

import { hasKanji, isKanjiChar, toHiragana } from './kana.js';

const KUROMOJI_SRC = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js';
const DICT_PATH = 'dict/';

let tokenizer = null;
let loading = null;
const listeners = new Set();

export function onReady(fn) {
  listeners.add(fn);
}

export function isReady() {
  return tokenizer !== null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(el);
  });
}

export function init() {
  if (loading) return loading;
  loading = (async () => {
    if (!window.kuromoji) await loadScript(KUROMOJI_SRC);
    tokenizer = await new Promise((resolve, reject) => {
      window.kuromoji.builder({ dicPath: DICT_PATH }).build((err, t) => (err ? reject(err) : resolve(t)));
    });
    listeners.forEach((fn) => fn());
    return tokenizer;
  })().catch((err) => {
    console.warn('ふりがな辞書を読み込めませんでした', err);
    loading = null;
    throw err;
  });
  return loading;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 「分かる」+「わかる」→ [{分,わ},{かる}] のように漢字部分だけに読みを割り当てる
export function alignReading(surface, reading) {
  const segs = [];
  for (const ch of surface) {
    const k = isKanjiChar(ch);
    const last = segs[segs.length - 1];
    if (last && last.kanji === k) last.text += ch;
    else segs.push({ text: ch, kanji: k });
  }
  const pattern = '^' + segs.map((s) => (s.kanji ? '(.+?)' : '(' + escapeRe(toHiragana(s.text)) + ')')).join('') + '$';
  const m = new RegExp(pattern).exec(reading);
  if (!m) return [{ text: surface, rt: reading }];
  return segs.map((s, i) => (s.kanji ? { text: s.text, rt: m[i + 1] } : { text: s.text }));
}

function tokenParts(text) {
  if (!tokenizer) return [{ text }];
  const parts = [];
  for (const tok of tokenizer.tokenize(text)) {
    const surface = tok.surface_form;
    const reading = tok.reading && tok.reading !== '*' ? toHiragana(tok.reading) : null;
    if (hasKanji(surface) && reading) parts.push(...alignReading(surface, reading));
    else parts.push({ text: surface });
  }
  return parts;
}

// テキスト → ふりがな付き HTML（辞書がまだならそのまま）
export function toRubyHtml(text) {
  if (text == null) return '';
  const str = String(text);
  if (!tokenizer || !hasKanji(str)) return escapeHtml(str).replace(/\n/g, '<br>');
  return tokenParts(str)
    .map((p) => (p.rt ? `<ruby>${escapeHtml(p.text)}<rt>${escapeHtml(p.rt)}</rt></ruby>` : escapeHtml(p.text)))
    .join('')
    .replace(/\n/g, '<br>');
}

// 単語の読み（ひらがな）。辞書にない部分があれば null
export function readingOf(word) {
  if (!tokenizer) return null;
  let out = '';
  for (const tok of tokenizer.tokenize(word)) {
    if (tok.reading && tok.reading !== '*') out += toHiragana(tok.reading);
    else if (!hasKanji(tok.surface_form)) out += toHiragana(tok.surface_form);
    else return null;
  }
  return out;
}

export { escapeHtml };
