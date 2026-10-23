// claude.ai の「sample」機能で、見ている人の Claude アカウントを使って会話を読み取り・添削する

import { hasKanji } from './kana.js';

export const MODEL = 'claude-haiku-5-5';
export const CATEGORIES = ['助詞', '敬語・丁寧さ', '語彙', '活用', '表記', '読み', '文脈'];

let samplePromise = null;

export function getSample() {
  if (!samplePromise) {
    const claude = window.claude;
    samplePromise = claude && typeof claude.use === 'function' ? claude.use('sample').catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}

// 1回に送れる画像の枚数（送れないときは 0）
export async function imageLimit() {
  const sample = await getSample();
  if (!sample) return 0;
  try {
    const limits = await sample.limits();
    return limits.images ? limits.images.maxCount : 0;
  } catch {
    return 0;
  }
}

const INSTRUCTIONS = `あなたは日本語の先生です。学習者はスペイン語が母語で、JLPT N3 に合格し、N2 を目指しています。
入力は LINE の会話のスクリーンショット、または会話のテキストです。学習者が自分の返信が正しく自然かを確かめるために使います。

## 会話の読み取り
- 会話を古い順に messages に入れる。LINE では右側（緑の吹き出し）が学習者本人（speaker: "self"）、左側が相手（speaker: "other"）。
- 時刻・既読・日付・名前・入力欄などの画面の文字は入れない。
- スタンプや写真は text に「[スタンプ：くまが泣いている]」のように短く書く。絵文字はそのまま残す。
- 複数の画像は続いた会話として読み、重なっている部分は1回だけ入れる。
- テキストで会話が渡された場合は、その speaker と text をそのまま使う（直さない）。

## self の発言の添削
- verdict: 正しくて自然なら "ok"、間違いではないが不自然なら "unnatural"、文法や意味の間違いがあれば "error"。
- 相手との関係に合った丁寧さか（タメ口・です/ます・敬語）を必ず見る。
- LINE らしいくだけた書き方（「！」「w」、句点なし、絵文字、「〜てる」「〜ちゃう」など）は間違いにしない。
- 伝わって自然なら ok にする。細かすぎる指摘はしない。どちらでもいいときは「どちらでもいい」と書く。
- 相手の発言とかみ合っているか（質問に答えているか、意味の取り違えがないか）も見る。ずれていれば category "文脈" で指摘する。
- issues: 間違い・不自然なところ1つにつき1つ。category は ${CATEGORIES.map((c) => `"${c}"`).join('・')} のどれか。original は問題の部分だけ、corrected はその直し、reason は理由。
- corrected: 文全体を直したもの（ok なら text と同じ）。
- alternatives: 関係に合った、より自然な言い方を 0〜3 個。
- explanation: 全体の説明（ほめるところがあればほめる）。
- self の meaning は ""。

## other の発言
- verdict は "none"、issues・alternatives は []、corrected・explanation は ""。
- meaning: 学習者にとって難しい発言なら、やさしい日本語で意味を書く。簡単なら ""。

## スラング・絵文字（self と other の両方）
- slang: スラング・略語・若者言葉・ネットの言葉（例：りょ、草、それな、ワンチャン）、意味のある絵文字・顔文字・スタンプ。
- expression: その表現、meaning: 意味とニュアンス、standard: 同じ意味の普通の言い方、ok_to_use: 学習者が使っていい相手（例：「友達ならOK。目上の人にはNG」）。
- 普通の言葉は入れない。なければ []。

## vocab
- 会話に出てきた漢字を含む言葉のうち、N3〜N1 レベルで学習者が覚えるとよいもの。最大 15 個。
- word は辞書形、reading はひらがな、meaning はやさしい日本語で短く、level は "N1"〜"N5" のどれか（わからなければ "不明"）。

## overall
- 会話全体へのひとこと（よかったところと、いちばん大事な注意を 1〜2 文）。

## 書き方（とても大事）
- 説明はすべて日本語で書く。スペイン語や英語は使わない。
- N3 の学習者がわかる、やさしい日本語で書く。難しい言葉や文法を使わない。1つの説明は 2〜3 文まで。

## 答えの形
JSON だけを返す。ほかの文は書かない。形は次のとおり（値は例）:
{
  "messages": [
    {"speaker": "other", "text": "明日ひま？", "verdict": "none", "issues": [], "corrected": "", "alternatives": [], "explanation": "", "meaning": "", "slang": []},
    {"speaker": "self", "text": "明日は大丈夫です", "verdict": "unnatural",
     "issues": [{"category": "敬語・丁寧さ", "original": "大丈夫です", "corrected": "大丈夫だよ", "reason": "友達には「です」は少しかたいです。"}],
     "corrected": "明日は大丈夫だよ！", "alternatives": ["明日ひまだよ！"], "explanation": "意味はよく伝わっています。", "meaning": "",
     "slang": []}
  ],
  "vocab": [{"word": "大丈夫", "reading": "だいじょうぶ", "meaning": "問題がない", "level": "N4"}],
  "overall": "自然な会話です。友達にはもう少しくだけた言い方でいいです。"
}`;

function buildPrompt({ transcript, relationship, draft, imageCount }) {
  let text = `${INSTRUCTIONS}\n\n## 今回の入力\n相手との関係: ${relationship}\n`;
  if (transcript && transcript.length) {
    text += '\n会話（テキスト）:\n' + transcript.map((m) => `${m.speaker === 'self' ? 'self' : 'other'}: ${m.text}`).join('\n') + '\n';
  }
  if (draft) text += '\n最後の self の発言は、まだ送っていない下書きです。送る前に直したいので、特にていねいに見てください。\n';
  if (imageCount) text += `\n画像は LINE のスクリーンショット ${imageCount} 枚です。上から順に会話が続いています。\n`;
  return text;
}

// 答えの形をそろえる（足りないところを埋め、おかしな値を直す）
const s = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

export function normalizeResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const messages = arr(r.messages)
    .filter((m) => m && typeof m === 'object' && s(m.text).trim())
    .map((m) => {
      const speaker = m.speaker === 'self' ? 'self' : 'other';
      const verdict = speaker === 'self' ? (['ok', 'unnatural', 'error'].includes(m.verdict) ? m.verdict : 'ok') : 'none';
      return {
        speaker,
        text: s(m.text),
        verdict,
        issues: speaker === 'self'
          ? arr(m.issues).filter((i) => i && (i.original || i.corrected)).map((i) => ({
            category: CATEGORIES.includes(i.category) ? i.category : '文脈',
            original: s(i.original), corrected: s(i.corrected), reason: s(i.reason),
          }))
          : [],
        corrected: speaker === 'self' ? s(m.corrected) : '',
        alternatives: speaker === 'self' ? arr(m.alternatives).map(s).filter(Boolean).slice(0, 3) : [],
        explanation: speaker === 'self' ? s(m.explanation) : '',
        meaning: speaker === 'other' ? s(m.meaning) : '',
        slang: arr(m.slang).filter((x) => x && s(x.expression).trim()).map((x) => ({
          expression: s(x.expression), meaning: s(x.meaning), standard: s(x.standard), ok_to_use: s(x.ok_to_use),
        })),
      };
    });
  const vocab = arr(r.vocab)
    .filter((v) => v && hasKanji(s(v.word)))
    .map((v) => ({ word: s(v.word), reading: s(v.reading), meaning: s(v.meaning), level: ['N1', 'N2', 'N3', 'N4', 'N5'].includes(v.level) ? v.level : '不明' }))
    .slice(0, 15);
  return { messages, vocab, overall: s(r.overall) };
}

export class ClaudeError extends Error {}

const ERROR_TEXT = {
  not_granted: 'Claude を使うことが許可されていません。もう一度ためして、「許可」を選んでください。',
  sampling_disabled: 'このアカウントでは Claude を使えません。',
  rate_limited: 'Claude の使える回数の上限に達しました。少し時間をおいてからためしてください。',
  session_expired: 'claude.ai にもう一度ログインしてください。',
  image_rejected: 'この画像は読めませんでした。別のスクショでためしてください。',
  images_unavailable: 'この画面では画像を送れません。「送る前の下書き」で文字を入れてためしてください。',
  refused: 'この内容はチェックできませんでした。別のスクショでためしてください。',
  empty_completion: '答えが返ってきませんでした。スクショを減らしてためしてください。',
  invalid_json: '答えの形がおかしかったので読めませんでした。もう一度ためしてください。',
  prompt_too_large: '会話が長すぎます。短くしてためしてください。',
};

export async function analyze({ images, transcript, relationship, draft, signal, onProgress }) {
  const sample = await getSample();
  if (!sample) throw new ClaudeError('チェックは claude.ai の中で開いたときだけ使えます。');
  const prompt = buildPrompt({ transcript, relationship, draft, imageCount: images ? images.length : 0 });
  const options = { model: MODEL, modelTier: 'quick', signal, onText: ({ text }) => onProgress && onProgress(text.length) };
  if (images && images.length) options.images = images;
  try {
    return normalizeResult(await sample.json(prompt, options));
  } catch (e) {
    const code = e && e.code;
    if (code === 'cancelled') throw new ClaudeError('');
    throw new ClaudeError(ERROR_TEXT[code] || 'エラーが起きました。もう一度ためしてください。');
  }
}
