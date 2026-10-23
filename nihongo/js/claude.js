// Claude API で LINE の会話を読み取り・添削する

import Anthropic from '../lib/anthropic-sdk.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（いちばん正確・おすすめ）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（速い・安い）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（とても安い・精度は下がる）' },
];

// サーバー側のフォールバック（安全フィルターで断られたとき別モデルでやり直す）に対応しているモデル
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export const CATEGORIES = ['助詞', '敬語・丁寧さ', '語彙', '活用', '表記', '読み', '文脈'];

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const SCHEMA = obj({
  messages: {
    type: 'array',
    items: obj({
      speaker: { type: 'string', enum: ['self', 'other'] },
      text: str,
      verdict: { type: 'string', enum: ['ok', 'unnatural', 'error', 'none'] },
      issues: {
        type: 'array',
        items: obj({
          category: { type: 'string', enum: CATEGORIES },
          original: str,
          corrected: str,
          reason: str,
        }),
      },
      corrected: str,
      alternatives: strArr,
      explanation: str,
      meaning: str,
      slang: {
        type: 'array',
        items: obj({ expression: str, meaning: str, standard: str, ok_to_use: str }),
      },
    }),
  },
  vocab: {
    type: 'array',
    items: obj({
      word: str,
      reading: str,
      meaning: str,
      level: { type: 'string', enum: ['N1', 'N2', 'N3', 'N4', 'N5', '不明'] },
    }),
  },
  overall: str,
});

const SYSTEM = `あなたは日本語の先生です。学習者はスペイン語が母語で、JLPT N3 に合格し、N2 を目指しています。
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
- issues: 間違い・不自然なところ1つにつき1つ。original は問題の部分だけ、corrected はその直し、reason は理由。
- corrected: 文全体を直したもの（ok なら text と同じ）。
- alternatives: 関係に合った、より自然な言い方を 0〜3 個（ok で十分自然なら 0 個でいい）。
- explanation: 全体の説明（ほめるところがあればほめる）。
- self の meaning は ""。

## other の発言
- verdict は "none"、issues・alternatives は空、corrected・explanation は ""。
- meaning: 学習者にとって難しい発言なら、やさしい日本語で意味を書く。簡単なら ""。

## スラング・絵文字（self と other の両方）
- slang: スラング・略語・若者言葉・ネットの言葉（例：りょ、草、それな、ワンチャン）、意味のある絵文字・顔文字・スタンプ。
- expression: その表現、meaning: 意味とニュアンス、standard: 同じ意味の普通の言い方、ok_to_use: 学習者が使っていい相手（例：「友達ならOK。目上の人にはNG」）。
- 普通の言葉は入れない。なければ空。

## vocab
- 会話に出てきた漢字を含む言葉のうち、N3〜N1 レベルで学習者が覚えるとよいもの。最大 15 個。
- word は辞書形、reading はひらがな、meaning はやさしい日本語で短く、level は JLPT のレベルの目安。

## overall
- 会話全体へのひとこと（よかったところと、いちばん大事な注意を 1〜2 文）。

## 書き方（とても大事）
- 説明はすべて日本語で書く。スペイン語や英語は使わない。
- N3 の学習者がわかる、やさしい日本語で書く。難しい言葉や文法を使わない。1つの説明は 2〜3 文まで。`;

function buildUserContent({ images, transcript, relationship, draft }) {
  const content = [];
  for (const img of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  let text = `相手との関係: ${relationship}\n`;
  if (transcript && transcript.length) {
    text += '\n会話（テキスト）:\n' + transcript.map((m) => `${m.speaker === 'self' ? 'self' : 'other'}: ${m.text}`).join('\n') + '\n';
  }
  if (draft) {
    text += '\n最後の self の発言は、まだ送っていない下書きです。送る前に直したいので、特にていねいに見てください。\n';
  }
  if (images && images.length) {
    text += `\n画像は ${images.length} 枚です。上から順に会話が続いています。`;
  }
  content.push({ type: 'text', text });
  return content;
}

export class ClaudeError extends Error {}

export async function analyze({ apiKey, model, images, transcript, relationship, draft }) {
  if (!apiKey) throw new ClaudeError('API キーが設定されていません。「設定」で入力してください。');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: buildUserContent({ images, transcript, relationship, draft }) }],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let response;
  try {
    response = await client.beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError('API キーが正しくないようです。「設定」で確かめてください。');
    if (err instanceof Anthropic.PermissionDeniedError) throw new ClaudeError('この API キーではこのモデルが使えません。「設定」でモデルを変えてみてください。');
    if (err instanceof Anthropic.RateLimitError) throw new ClaudeError('今、使える回数の上限に達しています。少し時間をおいてからもう一度ためしてください。');
    if (err instanceof Anthropic.BadRequestError) throw new ClaudeError('リクエストが受け付けられませんでした：' + (err.message || ''));
    if (err instanceof Anthropic.APIConnectionError) throw new ClaudeError('インターネットに接続できませんでした。電波を確かめてください。');
    if (err instanceof Anthropic.APIError) throw new ClaudeError('エラーが起きました（' + (err.status ?? '?') + '）。もう一度ためしてください。');
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new ClaudeError('この内容はチェックできませんでした。別のスクショでためしてください。');
  if (response.stop_reason === 'max_tokens') throw new ClaudeError('会話が長すぎて最後まで答えられませんでした。スクショを減らしてためしてください。');

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError('答えの形がおかしかったので読めませんでした。もう一度ためしてください。');
  }
}
