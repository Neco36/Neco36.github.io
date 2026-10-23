// かな変換・読みの正規化・誤答選択肢の生成

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]/;

export function hasKanji(s) {
  return KANJI_RE.test(s);
}

export function isKanjiChar(ch) {
  return KANJI_RE.test(ch);
}

export function toHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// ---- ローマ字 → ひらがな ----

const ROMAJI = {};
(function buildTable() {
  const rows = {
    '': ['あ', 'い', 'う', 'え', 'お'],
    k: ['か', 'き', 'く', 'け', 'こ'],
    s: ['さ', 'し', 'す', 'せ', 'そ'],
    t: ['た', 'ち', 'つ', 'て', 'と'],
    n: ['な', 'に', 'ぬ', 'ね', 'の'],
    h: ['は', 'ひ', 'ふ', 'へ', 'ほ'],
    m: ['ま', 'み', 'む', 'め', 'も'],
    y: ['や', 'い', 'ゆ', 'いぇ', 'よ'],
    r: ['ら', 'り', 'る', 'れ', 'ろ'],
    w: ['わ', 'うぃ', 'う', 'うぇ', 'を'],
    g: ['が', 'ぎ', 'ぐ', 'げ', 'ご'],
    z: ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'],
    d: ['だ', 'ぢ', 'づ', 'で', 'ど'],
    b: ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
    p: ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'],
    f: ['ふぁ', 'ふぃ', 'ふ', 'ふぇ', 'ふぉ'],
    j: ['じゃ', 'じ', 'じゅ', 'じぇ', 'じょ'],
    l: ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ'],
    x: ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ'],
  };
  const vowels = ['a', 'i', 'u', 'e', 'o'];
  for (const [c, kana] of Object.entries(rows)) {
    vowels.forEach((v, i) => (ROMAJI[c + v] = kana[i]));
  }
  const youon = { ky: 'き', sy: 'し', sh: 'し', ty: 'ち', cy: 'ち', ch: 'ち', ny: 'に', hy: 'ひ', my: 'み', ry: 'り', gy: 'ぎ', zy: 'じ', jy: 'じ', by: 'び', py: 'ぴ', dy: 'ぢ' };
  for (const [c, base] of Object.entries(youon)) {
    ROMAJI[c + 'a'] = base + 'ゃ';
    ROMAJI[c + 'u'] = base + 'ゅ';
    ROMAJI[c + 'o'] = base + 'ょ';
    ROMAJI[c + 'e'] = base + 'ぇ';
  }
  Object.assign(ROMAJI, {
    shi: 'し', chi: 'ち', tsu: 'つ', si: 'し', ti: 'ち', tu: 'つ', hu: 'ふ', fu: 'ふ',
    ji: 'じ', zi: 'じ', di: 'ぢ', du: 'づ', ye: 'いぇ', wo: 'を',
    she: 'しぇ', che: 'ちぇ', thi: 'てぃ', dhi: 'でぃ',
    xtu: 'っ', ltu: 'っ', xtsu: 'っ', ltsu: 'っ',
    xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ', xwa: 'ゎ', lwa: 'ゎ',
    '-': 'ー',
  });
})();

const CONSONANT = /[bcdfghjklmpqrstvwxyz]/;

export function romajiToHiragana(input) {
  const s = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === 'n') {
      if (next === "'") { out += 'ん'; i += 2; continue; }
      if (next === 'n') {
        // nn + 母音/y は「ん + な行」、それ以外は「ん」
        const after = s[i + 2];
        if (after && /[aiueoy]/.test(after)) { out += 'ん'; i += 1; continue; }
        out += 'ん'; i += 2; continue;
      }
      if (next === undefined || (CONSONANT.test(next) && next !== 'y')) { out += 'ん'; i += 1; continue; }
    }
    if (CONSONANT.test(c) && c === next && c !== 'n') { out += 'っ'; i += 1; continue; }
    let matched = false;
    for (let len = 4; len >= 1; len--) {
      const chunk = s.slice(i, i + len);
      if (ROMAJI[chunk]) { out += ROMAJI[chunk]; i += len; matched = true; break; }
    }
    if (!matched) { out += c; i += 1; }
  }
  return out;
}

export function normalizeReading(s) {
  let t = (s || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (/[a-zA-Z]/.test(t)) t = romajiToHiragana(t);
  return toHiragana(t);
}

// ---- 誤答選択肢（ありがちな読み間違い） ----

const VOICED = {
  か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ',
  た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ',
};
const UNVOICED = Object.fromEntries(Object.entries(VOICED).map(([a, b]) => [b, a]));
const HANDAKU = { は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ' };
const O_COLUMN = 'おこそとのほもよろごぞどぼぽょ';
const E_COLUMN = 'えけせてねへめれげぜでべぺ';
const SOKUON_OK = 'かきくけこさしすせそたちつてとぱぴぷぺぽ';

function readingVariants(r) {
  const out = new Set();
  const chars = [...r];
  chars.forEach((ch, i) => {
    const prev = chars[i - 1];
    const rest = chars.slice(i + 1).join('');
    const head = chars.slice(0, i).join('');
    // 長音を落とす
    if ((ch === 'う' && prev && (O_COLUMN.includes(prev) || prev === 'ゅ')) || (ch === 'い' && prev && E_COLUMN.includes(prev)) || ch === 'ー') {
      out.add(head + rest);
    }
    // 長音を足す
    if ((O_COLUMN.includes(ch) || ch === 'ゅ') && chars[i + 1] !== 'う') out.add(head + ch + 'う' + rest);
    // 促音を落とす・足す
    if (ch === 'っ') out.add(head + rest);
    if (i > 0 && SOKUON_OK.includes(ch) && prev !== 'っ' && prev !== 'ん') out.add(head + 'っ' + ch + rest);
    // 濁音・半濁音の付け外し
    if (VOICED[ch]) out.add(head + VOICED[ch] + rest);
    if (UNVOICED[ch]) out.add(head + UNVOICED[ch] + rest);
    if (HANDAKU[ch]) out.add(head + HANDAKU[ch] + rest);
  });
  out.delete(r);
  return [...out].filter((v) => v.length > 0);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 正解 + 3つの誤答（同じ語のほかの読みは誤答に入れない）
export function buildChoices(reading, otherReadings = [], accepted = []) {
  const bad = new Set([reading, ...accepted]);
  let pool = shuffle(readingVariants(reading)).filter((v) => !bad.has(v));
  const picked = pool.slice(0, 3);
  if (picked.length < 3) {
    const extra = shuffle(otherReadings.filter((v) => !bad.has(v) && !picked.includes(v)));
    extra.sort((a, b) => Math.abs(a.length - reading.length) - Math.abs(b.length - reading.length));
    picked.push(...extra.slice(0, 3 - picked.length));
  }
  return shuffle([reading, ...picked]);
}
