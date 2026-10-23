import { store, uid, initStore, onStatus, storageStatus } from './store.js';
import * as furi from './furigana.js';
import { analyze, getSample, imageLimit, CATEGORIES, ClaudeError } from './claude.js';
import { STARTER_VOCAB, TAGS } from './starter-vocab.js';
import { newCardState, grade, isDue, isLearned } from './srs.js';
import { normalizeReading, buildChoices, hasKanji } from './kana.js';

const f = furi.toRubyHtml;
const esc = (s) => furi.escapeHtml(String(s ?? ''));
const $app = document.getElementById('app');

const RELATIONSHIPS = ['友達', '恋人', '家族', '先輩・上司', '先生', '初めて話す人', 'お店・会社'];
const VERDICT = {
  ok: { label: 'いいね', cls: 'ok' },
  unnatural: { label: '少し不自然', cls: 'warn' },
  error: { label: '直したほうがいい', cls: 'bad' },
};
const SESSION_MAX = 30;
const TABS = ['check', 'review', 'notes', 'settings'];

const initialTab = location.hash.replace(/^#/, '');
const state = {
  route: { tab: TABS.includes(initialTab) ? initialTab : 'check', sub: '' },
  ready: false,
  check: {
    mode: 'screenshot', images: [], relationship: '友達', draftContext: '', draftText: '',
    loading: false, progress: 0, ctl: null, error: null, resultId: null,
    available: null, maxImages: 0,
  },
  editing: null,
  confirm: null,
  quiz: null,
  quizFilter: 'all',
  mistakeFilter: 'all',
  wordSearch: '',
  flash: null,
};

// ---------- 共通 ----------

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function go(to) {
  const [tab, sub = ''] = to.split('/');
  state.route = { tab, sub };
  state.editing = null;
  state.confirm = null;
  window.scrollTo(0, 0);
  render();
}

function flash(msg) {
  state.flash = msg;
  render();
  setTimeout(() => {
    if (state.flash === msg) { state.flash = null; render(); }
  }, 2500);
}

function navButton(to, label, cls = 'tiny') {
  return `<button class="${cls}" data-action="nav" data-to="${esc(to)}">${label}</button>`;
}

// ---------- データ操作 ----------

function findCardByWord(word) {
  return store.cards.find((c) => c.kind === 'vocab' && c.word === word);
}

function makeVocabCard({ word, reading, meaning, tags = [], accepted = [], source }) {
  // 基本の語と自分で入れた読みはそのまま使い、それ以外（AI の読み）は辞書の読みを優先する
  const given = normalizeReading(reading || '');
  const trusted = (source === 'starter' || source === 'manual') && given;
  const main = trusted ? given : furi.readingOf(word) || given;
  const acc = new Set(accepted.map(normalizeReading));
  if (given && given !== main) acc.add(given);
  acc.delete(main);
  return { id: uid(), kind: 'vocab', word, reading: main, meaning: meaning || '', tags, accepted: [...acc], source, added: Date.now(), ...newCardState() };
}

function addVocab(v, source) {
  if (!v.word || findCardByWord(v.word)) return false;
  const cards = store.cards;
  cards.push(makeVocabCard({ ...v, source }));
  store.saveCards(cards);
  return true;
}

function saveSlang(items, entryId) {
  if (!items.length) return;
  const list = store.slang;
  for (const s of items) {
    const found = list.find((x) => x.expression === s.expression);
    if (found) { found.count += 1; found.lastSeen = Date.now(); }
    else list.unshift({ id: uid(), ...s, count: 1, entryId, firstSeen: Date.now(), lastSeen: Date.now() });
  }
  store.saveSlang(list);
}

function saveMistakes(entry) {
  const list = store.mistakes.filter((m) => m.entryId !== entry.id);
  for (const msg of entry.messages) {
    if (msg.speaker !== 'self') continue;
    for (const is of msg.issues || []) {
      list.unshift({
        id: uid(), entryId: entry.id, date: entry.date, category: is.category,
        original: is.original, corrected: is.corrected, reason: is.reason,
        sentence: msg.text, correctedSentence: msg.corrected,
      });
    }
  }
  store.saveMistakes(list);
}

function storeResult(result, meta, existingId) {
  const entry = {
    id: existingId || uid(),
    date: Date.now(),
    relationship: meta.relationship,
    source: meta.source,
    messages: result.messages,
    vocab: result.vocab,
    overall: result.overall,
  };
  const history = store.history.filter((h) => h.id !== entry.id);
  history.unshift(entry);
  store.saveHistory(history);
  saveMistakes(entry);
  saveSlang(entry.messages.flatMap((m) => m.slang || []), entry.id);
  if (store.settings.autoAddVocab) {
    entry.vocab.filter((v) => v.level === 'N2' || v.level === 'N1').forEach((v) => addVocab(v, 'line'));
  }
  return entry;
}

// ---------- 画像 ----------

function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // どの形式の画像でも JPEG にそろえる（Claude 側でも約 1.2 メガピクセルに縮められる）
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) resolve({ id: uid(), preview: url, blob });
        else reject(new Error('画像を読み込めませんでした'));
      }, 'image/jpeg', 0.9);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

// ---------- チェック画面 ----------

function relationshipSelect(value, attr, id) {
  return `<select id="${id}" ${attr}>${RELATIONSHIPS.map((r) => `<option ${r === value ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
}

function renderCheck() {
  const c = state.check;
  const result = c.resultId ? store.history.find((h) => h.id === c.resultId) : null;
  const canImages = c.maxImages > 0;
  const unavailable = c.available === false;
  const mode = canImages ? c.mode : 'draft';
  return `
    ${unavailable ? `<div class="notice">${f('チェックは claude.ai の中でこのページを開いたときだけ使えます。漢字の練習とノートはこのまま使えます。')}</div>` : ''}
    <div class="segmented" role="group">
      <button data-action="check-mode" data-mode="screenshot" aria-pressed="${mode === 'screenshot'}" ${canImages ? '' : 'disabled'}>${f('スクショ')}</button>
      <button data-action="check-mode" data-mode="draft" aria-pressed="${mode === 'draft'}">${f('送る前の下書き')}</button>
    </div>
    <label class="field" for="rel">${f('相手との関係')}
      ${relationshipSelect(c.relationship, 'data-bind="relationship"', 'rel')}
    </label>
    ${mode === 'screenshot' ? `
      <label class="drop">
        <input type="file" id="pick" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-action="pick-images" hidden>
        <span class="drop-icon" aria-hidden="true">＋</span>
        <span>${f('LINE のスクショを選ぶ')}<br><small>${f(`${c.maxImages}枚まで。上から順に読みます`)}</small></span>
      </label>
      ${c.images.length ? `<div class="thumbs">${c.images.map((im) => `
        <div class="thumb"><img src="${im.preview}" alt=""><button class="thumb-x" data-action="remove-image" data-id="${im.id}" aria-label="${esc('消す')}">×</button></div>`).join('')}</div>` : ''}
      <p class="hint">${f('画像は保存しません。保存するのは読み取った文字だけです。')}</p>
    ` : `
      <label class="field" for="ctx">${f('相手のメッセージ（なくてもいい）')}
        <textarea id="ctx" rows="2" data-bind="draftContext" placeholder="${esc('例：明日ひま？')}">${esc(c.draftContext)}</textarea>
      </label>
      <label class="field" for="draft">${f('あなたの返信（下書き）')}
        <textarea id="draft" rows="3" data-bind="draftText" placeholder="${esc('例：明日は行けるかどうか分からないです')}">${esc(c.draftText)}</textarea>
      </label>
    `}
    ${c.loading ? `
      <div class="loading-row">
        <span class="spinner" aria-hidden="true"></span>
        <span>${f(c.progress ? `書いています…（${c.progress}文字）` : '考えています…')}</span>
        <button class="tiny" data-action="stop-check">${f('やめる')}</button>
      </div>` : `
      <button class="primary" data-action="run-check" ${unavailable || c.available === null ? 'disabled' : ''}>${f('チェックする')}</button>`}
    ${c.error ? `<div class="error">${f(c.error)}</div>` : ''}
    <p class="hint">${f('チェックはあなたの Claude アカウント（Haiku）で動きます。はじめてのときは「許可」を聞かれます。')}</p>
    ${result ? `<hr>${renderResult(result)}` : ''}
  `;
}

function renderIssue(is) {
  return `<li class="issue">
    <span class="chip">${f(is.category)}</span>
    <div><span class="strike">${f(is.original)}</span> → <strong>${f(is.corrected)}</strong></div>
    <div class="muted">${f(is.reason)}</div>
  </li>`;
}

function renderSlang(list) {
  if (!list || !list.length) return '';
  return `<div class="slang-box">${list.map((s) => `
    <div class="slang"><strong>${f(s.expression)}</strong>：${f(s.meaning)}
      ${s.standard ? `<div class="muted">${f('ふつうの言い方')}：${f(s.standard)}</div>` : ''}
      ${s.ok_to_use ? `<div class="muted">${f('使っていい相手')}：${f(s.ok_to_use)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function renderMessage(m, i, entry) {
  const self = m.speaker === 'self';
  const v = VERDICT[m.verdict];
  const ed = state.editing;
  if (ed && ed.entry === entry.id && ed.i === i) {
    return `<div class="msg ${self ? 'self' : 'other'}">
      <div class="edit-box">
        <textarea id="edit-${i}" rows="2" data-bind="editText">${esc(ed.text)}</textarea>
        <div class="row">
          <button class="secondary" data-action="edit-cancel">${f('やめる')}</button>
          <button class="primary" data-action="edit-save">${f('直す')}</button>
        </div>
      </div>
    </div>`;
  }
  const controls = `<div class="msg-tools">
      <button class="tiny" data-action="flip-speaker" data-entry="${entry.id}" data-i="${i}" aria-label="${esc('話す人を入れかえる')}" title="${esc('話す人を入れかえる')}">⇄</button>
      <button class="tiny" data-action="edit-text" data-entry="${entry.id}" data-i="${i}" aria-label="${esc('文を直す')}" title="${esc('文を直す')}">✎</button>
    </div>`;
  let detail = '';
  if (self && v) {
    detail = `<div class="feedback">
      <span class="badge ${v.cls}">${f(v.label)}</span>
      ${m.issues && m.issues.length ? `<ul class="issues">${m.issues.map(renderIssue).join('')}</ul>` : ''}
      ${m.corrected && m.corrected !== m.text ? `<div class="corrected"><span class="label">${f('直した文')}</span>${f(m.corrected)}</div>` : ''}
      ${m.alternatives && m.alternatives.length ? `<div class="alts"><span class="label">${f('もっと自然な言い方')}</span><ul>${m.alternatives.map((a) => `<li>${f(a)}</li>`).join('')}</ul></div>` : ''}
      ${m.explanation ? `<p>${f(m.explanation)}</p>` : ''}
    </div>`;
  } else if (!self && m.meaning) {
    detail = `<div class="feedback other"><span class="label">${f('意味')}</span>${f(m.meaning)}</div>`;
  }
  return `<div class="msg ${self ? 'self' : 'other'}">
    <div class="bubble-row">${self ? controls : ''}<div class="bubble">${f(m.text)}</div>${self ? '' : controls}</div>
    ${detail}
    ${renderSlang(m.slang)}
  </div>`;
}

function renderResult(entry) {
  const cards = store.cards;
  const vocab = entry.vocab || [];
  const c = state.check;
  return `
    <div class="result-meta muted">${esc(fmtDate(entry.date))} ・ ${f(entry.relationship)}</div>
    ${entry.overall ? `<div class="overall">${f(entry.overall)}</div>` : ''}
    <div class="chat">${entry.messages.map((m, i) => renderMessage(m, i, entry)).join('')}</div>
    ${entry.edited ? (c.loading ? `<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span>${f('考えています…')}</span></div>`
      : `<button class="primary" data-action="recheck" data-entry="${entry.id}">${f('直した会話でもう一度チェック')}</button>
         ${c.error ? `<div class="error">${f(c.error)}</div>` : ''}`) : ''}
    ${vocab.length ? `
      <h3>${f('出てきた言葉')}</h3>
      <ul class="vocab-list">${vocab.map((v, i) => {
        const added = cards.some((x) => x.kind === 'vocab' && x.word === v.word);
        return `<li>
          <div class="grow"><span class="word">${esc(v.word)}</span> <span class="reading">${esc(v.reading)}</span> <span class="chip small">${esc(v.level)}</span>
            <div class="muted">${f(v.meaning)}</div></div>
          <button class="small ${added ? 'done' : ''}" data-action="add-vocab" data-entry="${entry.id}" data-i="${i}" ${added ? 'disabled' : ''}>${added ? f('追加済み') : f('練習に追加')}</button>
        </li>`;
      }).join('')}</ul>
      <button class="secondary wide" data-action="add-all-vocab" data-entry="${entry.id}">${f('全部練習に追加')}</button>` : ''}
  `;
}

async function runCheck(opts) {
  const c = state.check;
  c.loading = true;
  c.progress = 0;
  c.error = null;
  c.ctl = new AbortController();
  render();
  try {
    const result = await analyze({
      relationship: opts.relationship,
      signal: c.ctl.signal,
      onProgress: (n) => { c.progress = n; updateProgress(); },
      ...opts.request,
    });
    if (!result.messages.length) throw new ClaudeError('会話を読み取れませんでした。LINE の画面のスクショか確かめてください。');
    const entry = storeResult(result, { relationship: opts.relationship, source: opts.source }, opts.existingId);
    c.resultId = entry.id;
    if (opts.source === 'screenshot') {
      c.images.forEach((im) => URL.revokeObjectURL(im.preview));
      c.images = [];
    }
  } catch (err) {
    console.error(err);
    c.error = err instanceof ClaudeError ? err.message || null : 'エラーが起きました。もう一度ためしてください。';
  } finally {
    c.loading = false;
    c.ctl = null;
    render();
  }
}

// 文字数だけ書きかえる（全体を描き直すと重いので）
function updateProgress() {
  const el = $app.querySelector('.loading-row span:nth-child(2)');
  if (el) el.innerHTML = f(`書いています…（${state.check.progress}文字）`);
}

// ---------- 復習画面 ----------

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function newLeftToday() {
  const d = store.daily;
  const used = d.date === todayKey() ? d.newCount : 0;
  return Math.max(0, store.settings.newPerDay - used);
}

function matchesFilter(item, filter) {
  if (filter === 'all') return true;
  if (filter === 'line') return item.kind === 'vocab' && item.source === 'line';
  if (filter === 'mistake') return item.kind === 'mistake';
  if (filter === 'manual') return item.kind === 'vocab' && item.source === 'manual';
  return item.kind === 'vocab' && (item.tags || []).includes(filter);
}

function buildQueue(filter) {
  const now = Date.now();
  const cards = store.cards;
  const due = cards.filter((c) => isDue(c, now) && matchesFilter(c, filter)).sort((a, b) => a.due - b.due);
  const queue = due.slice(0, SESSION_MAX).map((c) => ({ cardId: c.id }));
  const room = Math.min(newLeftToday(), SESSION_MAX - queue.length);
  if (room > 0 && !['line', 'mistake', 'manual'].includes(filter)) {
    const known = new Set(cards.map((c) => c.word));
    const fresh = STARTER_VOCAB.filter((v) => !known.has(v.word) && (filter === 'all' || v.tags.includes(filter)));
    fresh.slice(0, room).forEach((v) => queue.push({ starter: v }));
  }
  return queue;
}

function currentItem() {
  const q = state.quiz;
  const item = q.queue[q.index];
  if (!item) return null;
  if (item.starter) return { item, card: { kind: 'vocab', ...item.starter, reps: 0, isNew: true } };
  const card = store.cards.find((c) => c.id === item.cardId);
  return card ? { item, card } : null;
}

function quizModeFor(card) {
  const m = store.settings.quizMode;
  if (m === 'choice' || m === 'input') return m;
  return card.reps < 2 ? 'choice' : 'input';
}

function renderReviewHome() {
  const cards = store.cards;
  const now = Date.now();
  const dueCount = cards.filter((c) => isDue(c, now)).length;
  const learned = cards.filter(isLearned).length;
  const vocabTotal = cards.filter((c) => c.kind === 'vocab').length;
  const known = new Set(cards.map((c) => c.word));
  const starterLeft = STARTER_VOCAB.filter((v) => !known.has(v.word)).length;
  const filters = [['all', 'すべて'], ['line', 'LINE から'], ['mistake', '間違いノート'], ['manual', '自分で追加'], ...TAGS.map((t) => [t, t])];
  return `
    <div class="stats">
      <div class="stat"><span class="num">${dueCount}</span><span>${f('今日の復習')}</span></div>
      <div class="stat"><span class="num">${newLeftToday()}</span><span>${f('新しい語')}</span></div>
      <div class="stat"><span class="num">${learned}</span><span>${f('覚えた')}</span></div>
    </div>
    <label class="field" for="qf">${f('出す問題')}
      <select id="qf" data-bind="quizFilter">${filters.map(([v, l]) => `<option value="${esc(v)}" ${state.quizFilter === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </label>
    <button class="primary" data-action="start-quiz">${f('練習を始める')}</button>
    <p class="hint">${f(`練習リスト ${vocabTotal}語 ・ まだ出ていない基本の語 ${starterLeft}語`)}</p>
    <p class="hint">${f('「LINE から」は、チェックで出てきた言葉です。間違えた問題は、その練習の最後にもう一度出ます。')}</p>
  `;
}

function highlight(sentence, part) {
  const i = part ? sentence.indexOf(part) : -1;
  if (i < 0) return f(sentence);
  return f(sentence.slice(0, i)) + `<mark>${f(part)}</mark>` + f(sentence.slice(i + part.length));
}

function renderQuiz() {
  const q = state.quiz;
  const cur = currentItem();
  if (!cur) {
    const total = q.correct + q.wrong;
    return `<div class="done-box">
      <h2>${f('おつかれさま！')}</h2>
      <p>${total ? f(`${total}問中 ${q.correct}問 正解`) : f('今は復習する問題がありません。')}</p>
      <button class="primary" data-action="end-quiz">${f('もどる')}</button>
    </div>`;
  }
  const { card } = cur;
  const progress = `<div class="progress"><div style="width:${Math.round((q.index / q.queue.length) * 100)}%"></div></div>
    <div class="quiz-top"><span class="muted num-tab">${q.index + 1} / ${q.queue.length}</span><button class="tiny" data-action="end-quiz">${f('やめる')}</button></div>`;

  if (card.kind === 'mistake') {
    return `${progress}
      <div class="quiz-card">
        <div class="muted">${f('この文の間違いを直してください')} <span class="chip small">${f(card.category)}</span></div>
        <p class="quiz-sentence">${highlight(card.sentence, card.original)}</p>
        ${q.revealed ? `
          <div class="answer"><strong>${f(card.correctedSentence || card.corrected)}</strong>
            <div class="muted">${f(card.original)} → ${f(card.corrected)}：${f(card.reason)}</div></div>
          <div class="row">
            <button class="secondary" data-action="self-grade" data-ok="0">${f('まだ')}</button>
            <button class="primary" data-action="self-grade" data-ok="1">${f('わかった')}</button>
          </div>` : `<button class="primary" data-action="reveal">${f('答えを見る')}</button>`}
      </div>`;
  }

  const mode = q.mode || (q.mode = quizModeFor(card));
  let body;
  if (q.answered) {
    const ok = q.lastOk;
    body = `<div class="answer ${ok ? 'ok' : 'bad'}">
        <div class="verdict">${ok ? '◯ ' + f('正解') : '× ' + f('ざんねん')}</div>
        <div class="big-reading">${esc(card.reading)}</div>
        ${card.accepted && card.accepted.length ? `<div class="muted">${f('ほかの読み')}：${esc(card.accepted.join('、'))}</div>` : ''}
        ${!ok && q.given ? `<div class="muted">${f('あなたの答え')}：${esc(q.given)}</div>` : ''}
        <div>${f(card.meaning)}</div>
      </div>
      <div class="row">
        ${!ok && mode === 'input' ? `<button class="secondary" data-action="override">${f('合っていた')}</button>` : ''}
        <button class="primary" data-action="next" autofocus>${f('次へ')}</button>
      </div>`;
  } else if (mode === 'choice') {
    const others = STARTER_VOCAB.map((v) => v.reading).concat(store.cards.filter((c) => c.kind === 'vocab').map((c) => c.reading));
    q.choices = q.choices || buildChoices(card.reading, others, card.accepted);
    body = `<div class="choices">${q.choices.map((ch) => `<button class="choice" data-action="choose" data-value="${esc(ch)}">${esc(ch)}</button>`).join('')}</div>`;
  } else {
    body = `<form data-action="submit-reading" class="input-row">
        <input id="reading" name="reading" lang="ja" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc('ひらがなで入力')}" autofocus>
        <button class="primary" type="submit">${f('答える')}</button>
      </form>
      <p class="hint">${f('ローマ字でもOK（例：kekka）')}</p>
      <button class="tiny" data-action="switch-mode">${f('選択式にする')}</button>`;
  }
  return `${progress}
    <div class="quiz-card">
      <div class="muted">${f('読み方は？')} ${card.isNew ? `<span class="chip small new">${f('新しい語')}</span>` : ''} ${(card.tags || []).map((t) => `<span class="chip small">${esc(t)}</span>`).join('')}</div>
      <div class="quiz-word">${esc(card.word)}</div>
      ${body}
    </div>`;
}

function answerQuiz(ok, given) {
  const q = state.quiz;
  q.answered = true;
  q.lastOk = ok;
  q.given = given || '';
}

function commitAnswer(ok) {
  const q = state.quiz;
  const cur = currentItem();
  if (!cur) return;
  const cards = store.cards;
  let card;
  if (cur.item.starter) {
    card = makeVocabCard({ ...cur.item.starter, source: 'starter' });
    cards.push(card);
    const d = store.daily;
    store.saveDaily({ date: todayKey(), newCount: (d.date === todayKey() ? d.newCount : 0) + 1 });
    cur.item.starter = null;
    cur.item.cardId = card.id;
  } else {
    card = cards.find((c) => c.id === cur.item.cardId);
  }
  q.prevCard = card;
  const updated = grade(card, ok);
  cards[cards.findIndex((c) => c.id === card.id)] = updated;
  store.saveCards(cards);
  if (ok) q.correct += 1;
  else {
    q.wrong += 1;
    if (!cur.item.requeued) q.queue.push({ cardId: card.id, requeued: true });
  }
}

function nextQuestion() {
  const q = state.quiz;
  q.index += 1;
  q.answered = false;
  q.revealed = false;
  q.choices = null;
  q.mode = null;
  q.given = '';
}

// ---------- ノート画面 ----------

function renderNotes(sub) {
  const tabs = [['mistakes', '間違い'], ['slang', 'スラング'], ['words', '単語'], ['history', '履歴']];
  if (sub && sub.startsWith('entry:')) return renderHistoryDetail(sub.slice(6));
  const active = tabs.some(([k]) => k === sub) ? sub : 'mistakes';
  const body = { mistakes: renderMistakes, slang: renderSlangBook, words: renderWords, history: renderHistoryList }[active]();
  return `<div class="segmented" role="group">${tabs.map(([k, l]) => `<button data-action="nav" data-to="notes/${k}" aria-pressed="${k === active}">${f(l)}</button>`).join('')}</div>${body}`;
}

function renderMistakes() {
  const list = store.mistakes;
  if (!list.length) return `<p class="empty">${f('まだ間違いはありません。チェックすると、ここに自動でたまります。')}</p>`;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  list.forEach((m) => (counts[m.category] = (counts[m.category] || 0) + 1));
  const max = Math.max(...Object.values(counts), 1);
  const week = Date.now() - 7 * 864e5;
  const recent = {};
  list.filter((m) => m.date >= week).forEach((m) => (recent[m.category] = (recent[m.category] || 0) + 1));
  const top = Object.entries(recent).sort((a, b) => b[1] - a[1])[0];
  const cards = store.cards;
  const history = store.history;
  const filtered = state.mistakeFilter === 'all' ? list : list.filter((m) => m.category === state.mistakeFilter);
  return `
    ${top ? `<div class="overall">${f(`この1週間は「${top[0]}」の間違いがいちばん多いです（${top[1]}回）。`)}</div>` : ''}
    <div class="bars">${CATEGORIES.map((c) => `
      <button class="bar-row ${state.mistakeFilter === c ? 'active' : ''}" data-action="mistake-filter" data-cat="${esc(c)}" aria-pressed="${state.mistakeFilter === c}">
        <span class="bar-label">${f(c)}</span><span class="bar"><span style="width:${(counts[c] / max) * 100}%"></span></span><span class="bar-num">${counts[c]}</span>
      </button>`).join('')}</div>
    ${state.mistakeFilter !== 'all' ? `<button class="tiny" data-action="mistake-filter" data-cat="all">${f('すべて表示')}</button>` : ''}
    <ul class="notes">${filtered.map((m) => {
      const inReview = cards.some((c) => c.kind === 'mistake' && c.mistakeId === m.id);
      const hasEntry = history.some((h) => h.id === m.entryId);
      return `<li>
        <div class="note-head"><span class="chip small">${f(m.category)}</span><span class="muted num-tab">${esc(fmtDate(m.date))}</span></div>
        <div><span class="strike">${f(m.original)}</span> → <strong>${f(m.corrected)}</strong></div>
        <div class="muted">${f(m.reason)}</div>
        <div class="sentence">${f(m.sentence)}<br>→ ${f(m.correctedSentence)}</div>
        <div class="row">
          ${hasEntry ? navButton(`notes/entry:${m.entryId}`, f('会話を見る')) : ''}
          <button class="tiny ${inReview ? 'done' : ''}" data-action="mistake-to-review" data-id="${m.id}" ${inReview ? 'disabled' : ''}>${inReview ? f('復習に入っています') : f('復習に追加')}</button>
        </div>
      </li>`;
    }).join('')}</ul>`;
}

function renderSlangBook() {
  const list = store.slang;
  if (!list.length) return `<p class="empty">${f('まだありません。相手のメッセージにスラングや絵文字があると、ここに自動でたまります。')}</p>`;
  return `<ul class="notes">${list.map((s) => `<li>
      <div class="note-head"><strong class="slang-word">${f(s.expression)}</strong><span class="muted">${f(`${s.count}回`)}</span></div>
      <div>${f(s.meaning)}</div>
      ${s.standard ? `<div class="muted">${f('ふつうの言い方')}：${f(s.standard)}</div>` : ''}
      ${s.ok_to_use ? `<div class="muted">${f('使っていい相手')}：${f(s.ok_to_use)}</div>` : ''}
      <div class="row">${confirmButton(`slang:${s.id}`, 'delete-slang', s.id, '消す')}</div>
    </li>`).join('')}</ul>`;
}

// 2回押すと実行するボタン（このページでは確認ダイアログが使えないため）
function confirmButton(key, action, id, label) {
  if (state.confirm === key) {
    return `<button class="tiny danger" data-action="${action}" data-id="${esc(id)}">${f('本当に' + label)}</button>
      <button class="tiny" data-action="confirm-cancel">${f('やめる')}</button>`;
  }
  return `<button class="tiny" data-action="confirm-ask" data-key="${esc(key)}" aria-label="${esc(label)}">${f(label)}</button>`;
}

function renderWords() {
  const q = state.wordSearch.trim();
  const list = store.cards.filter((c) => c.kind === 'vocab' && (!q || c.word.includes(q) || c.reading.includes(normalizeReading(q)))).sort((a, b) => b.added - a.added);
  const sourceLabel = { line: 'LINE', starter: '基本', manual: '自分' };
  return `
    <form class="add-word" data-action="add-word">
      <input id="nw-word" name="word" placeholder="${esc('言葉（例：雰囲気）')}" aria-label="${esc('言葉')}" required>
      <input id="nw-reading" name="reading" placeholder="${esc('読み（なければ自動）')}" aria-label="${esc('読み')}">
      <input id="nw-meaning" name="meaning" placeholder="${esc('意味（なくてもいい）')}" aria-label="${esc('意味')}">
      <button class="primary" type="submit">${f('追加')}</button>
    </form>
    <input id="search" class="search" type="search" data-bind="wordSearch" placeholder="${esc('さがす')}" aria-label="${esc('さがす')}" value="${esc(state.wordSearch)}">
    ${list.length ? `<ul class="notes">${list.map((c) => `<li class="word-row">
        <div class="grow"><span class="word">${esc(c.word)}</span> <span class="reading">${esc(c.reading)}</span>
          <div class="muted">${f(c.meaning)}</div>
          <div class="muted small">${f(sourceLabel[c.source] || '')} ・ ${isLearned(c) ? f('覚えた') : f('練習中')} ・ ${f('次')} <span class="num-tab">${esc(fmtDate(c.due))}</span></div></div>
        <div class="row tight">${confirmButton(`card:${c.id}`, 'delete-card', c.id, '消す')}</div>
      </li>`).join('')}</ul>` : `<p class="empty">${f('練習リストはまだ空です。復習を始めると基本の語が入ります。')}</p>`}`;
}

function renderHistoryList() {
  const list = store.history;
  if (!list.length) return `<p class="empty">${f('まだチェックした会話はありません。')}</p>`;
  return `<ul class="notes">${list.map((h) => {
    const self = h.messages.filter((m) => m.speaker === 'self');
    const issues = self.reduce((n, m) => n + (m.issues || []).length, 0);
    const first = (self[0] || h.messages[0] || { text: '' }).text;
    return `<li><button class="history-link" data-action="nav" data-to="notes/entry:${h.id}">
      <div class="note-head"><span class="muted"><span class="num-tab">${esc(fmtDate(h.date))}</span> ・ ${f(h.relationship)}</span><span class="chip small">${f(issues ? `指摘 ${issues}` : 'OK')}</span></div>
      <div class="ellipsis">${esc(first)}</div></button></li>`;
  }).join('')}</ul>`;
}

function renderHistoryDetail(id) {
  const entry = store.history.find((h) => h.id === id);
  const back = navButton('notes/history', '← ' + f('履歴'), 'back');
  if (!entry) return `${back}<p class="empty">${f('見つかりませんでした。')}</p>`;
  return `${back}${renderResult(entry)}`;
}

// ---------- 設定画面 ----------

function renderSettings() {
  const s = store.settings;
  const st = storageStatus();
  return `
    <section class="card">
      <h3>${f('チェック')}</h3>
      <p class="hint">${f('チェックは、このページを開いている人の Claude アカウントで動きます（モデル：Claude Haiku 5.5）。API キーやお金の設定はいりません。使った分は、ふだんの Claude の使用量に入ります。')}</p>
      <label class="field" for="set-rel">${f('いつもの相手との関係')}
        ${relationshipSelect(s.relationship, 'data-setting="relationship"', 'set-rel')}
      </label>
      <label class="check" for="set-auto"><input id="set-auto" type="checkbox" data-setting="autoAddVocab" ${s.autoAddVocab ? 'checked' : ''}> <span>${f('N2・N1 の言葉は自動で練習に追加')}</span></label>
    </section>
    <section class="card">
      <h3>${f('練習')}</h3>
      <label class="field" for="set-new">${f('1日の新しい語の数')}
        <input id="set-new" type="number" min="0" max="50" data-setting="newPerDay" value="${s.newPerDay}">
      </label>
      <label class="field" for="set-mode">${f('出し方')}
        <select id="set-mode" data-setting="quizMode">
          <option value="auto" ${s.quizMode === 'auto' ? 'selected' : ''}>${esc('自動（はじめは選択式、慣れたら入力）')}</option>
          <option value="choice" ${s.quizMode === 'choice' ? 'selected' : ''}>${esc('いつも選択式')}</option>
          <option value="input" ${s.quizMode === 'input' ? 'selected' : ''}>${esc('いつも入力')}</option>
        </select>
      </label>
      <label class="check" for="set-furi"><input id="set-furi" type="checkbox" data-setting="furigana" ${s.furigana ? 'checked' : ''}> <span>${f('ふりがなを表示')}</span></label>
      <p class="hint">${f(furi.isReady() ? 'ふりがな辞書：読み込み済み' : 'ふりがな辞書：読み込み中…（はじめだけ少し時間がかかります）')}</p>
    </section>
    <section class="card">
      <h3>${f('記録')}</h3>
      <p class="hint">${f(st.mode === 'cloud' ? '記録はあなたの Claude アカウントに保存されます。ほかのスマホやパソコンで開いても同じ記録を使えます。' : st.mode === 'loading' ? '記録を読み込んでいます…' : '記録はこの端末のブラウザの中だけに保存されます。')}</p>
      <div class="row">${confirmButton('clear-all', 'clear', '', '記録を全部消す')}</div>
    </section>`;
}

// ---------- 描画 ----------

function render() {
  const { tab, sub } = state.route;
  document.body.classList.toggle('no-furigana', !store.settings.furigana);
  let view;
  if (!state.ready) view = `<p class="empty">${f('読み込み中…')}</p>`;
  else if (tab === 'review') view = state.quiz ? renderQuiz() : renderReviewHome();
  else if (tab === 'notes') view = renderNotes(sub);
  else if (tab === 'settings') view = renderSettings();
  else view = renderCheck();

  const nav = [['check', 'チェック', '✓'], ['review', '復習', '↻'], ['notes', 'ノート', '≡'], ['settings', '設定', '⚙']];
  const focused = document.activeElement;
  const focusId = focused && focused.id && $app.contains(focused) ? focused.id : null;
  const st = storageStatus();
  $app.innerHTML = `
    <header class="top">
      <h1>${f('にほんごチェック')}</h1>
      <button class="tiny" data-action="toggle-furigana" aria-pressed="${store.settings.furigana}">${store.settings.furigana ? 'ふりがな ON' : 'ふりがな OFF'}</button>
    </header>
    <main>
      ${st.message ? `<div class="notice small-notice">${f(st.message)}</div>` : ''}
      ${view}
    </main>
    ${state.flash ? `<div class="toast" role="status">${f(state.flash)}</div>` : ''}
    <nav class="tabs">${nav.map(([k, l, icon]) => `<button data-action="nav" data-to="${k}" class="${k === tab ? 'active' : ''}" ${k === tab ? 'aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${f(l)}</button>`).join('')}</nav>`;
  const again = focusId && document.getElementById(focusId);
  if (again) {
    again.focus({ preventScroll: true });
    if (again.setSelectionRange && typeof again.value === 'string' && again.type !== 'number') {
      try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* 選択できない入力欄 */ }
    }
  } else {
    const auto = $app.querySelector('main [autofocus]');
    if (auto) auto.focus({ preventScroll: true });
  }
}

// ---------- イベント ----------

function getEntry(id) {
  return store.history.find((h) => h.id === id);
}

function updateEntry(entry) {
  store.saveHistory(store.history.map((h) => (h.id === entry.id ? entry : h)));
}

const actions = {
  nav: (el) => go(el.dataset.to),
  'check-mode': (el) => { state.check.mode = el.dataset.mode; render(); },
  'remove-image': (el) => {
    const im = state.check.images.find((x) => x.id === el.dataset.id);
    if (im) URL.revokeObjectURL(im.preview);
    state.check.images = state.check.images.filter((x) => x.id !== el.dataset.id);
    render();
  },
  'run-check': () => {
    const c = state.check;
    const mode = c.maxImages > 0 ? c.mode : 'draft';
    if (mode === 'screenshot') {
      if (!c.images.length) { c.error = 'スクショを選んでください。'; render(); return; }
      runCheck({ source: 'screenshot', relationship: c.relationship, request: { images: c.images.map((im) => im.blob) } });
    } else {
      if (!c.draftText.trim()) { c.error = '返信の下書きを入力してください。'; render(); return; }
      const transcript = [];
      if (c.draftContext.trim()) transcript.push({ speaker: 'other', text: c.draftContext.trim() });
      transcript.push({ speaker: 'self', text: c.draftText.trim() });
      runCheck({ source: 'draft', relationship: c.relationship, request: { transcript, draft: true } });
    }
  },
  'stop-check': () => { if (state.check.ctl) state.check.ctl.abort(); },
  'flip-speaker': (el) => {
    const entry = getEntry(el.dataset.entry);
    const m = entry.messages[+el.dataset.i];
    m.speaker = m.speaker === 'self' ? 'other' : 'self';
    entry.edited = true;
    updateEntry(entry);
    render();
  },
  'edit-text': (el) => {
    const entry = getEntry(el.dataset.entry);
    state.editing = { entry: entry.id, i: +el.dataset.i, text: entry.messages[+el.dataset.i].text };
    render();
    const box = document.getElementById(`edit-${el.dataset.i}`);
    if (box) box.focus();
  },
  'edit-cancel': () => { state.editing = null; render(); },
  'edit-save': () => {
    const ed = state.editing;
    const entry = getEntry(ed.entry);
    const text = ed.text.trim();
    if (text && text !== entry.messages[ed.i].text) {
      entry.messages[ed.i].text = text;
      entry.edited = true;
      updateEntry(entry);
    }
    state.editing = null;
    render();
  },
  recheck: (el) => {
    const entry = getEntry(el.dataset.entry);
    runCheck({
      source: entry.source,
      relationship: entry.relationship,
      existingId: entry.id,
      request: { transcript: entry.messages.map(({ speaker, text }) => ({ speaker, text })) },
    });
  },
  'add-vocab': (el) => {
    const v = getEntry(el.dataset.entry).vocab[+el.dataset.i];
    if (addVocab(v, 'line')) flash(`「${v.word}」を練習に追加しました`);
  },
  'add-all-vocab': (el) => {
    const n = getEntry(el.dataset.entry).vocab.filter((v) => addVocab(v, 'line')).length;
    flash(n ? `${n}語を練習に追加しました` : 'もう全部追加されています');
  },
  'start-quiz': () => {
    state.quiz = { queue: buildQueue(state.quizFilter), index: 0, correct: 0, wrong: 0 };
    render();
  },
  'end-quiz': () => { state.quiz = null; render(); },
  choose: (el) => {
    const cur = currentItem();
    const given = el.dataset.value;
    const ok = given === cur.card.reading || (cur.card.accepted || []).includes(given);
    commitAnswer(ok);
    answerQuiz(ok, given);
    render();
  },
  'switch-mode': () => { state.quiz.mode = 'choice'; render(); },
  override: () => {
    // 入力の答えが実は正しかったとき：間違いとして記録した分をやり直す
    const q = state.quiz;
    const cur = currentItem();
    const cards = store.cards;
    const idx = cards.findIndex((c) => c.id === cur.item.cardId);
    if (idx >= 0 && q.prevCard) {
      cards[idx] = grade(q.prevCard, true);
      const given = normalizeReading(q.given);
      if (given && given !== cards[idx].reading && !cards[idx].accepted.includes(given)) cards[idx].accepted = [...cards[idx].accepted, given];
      store.saveCards(cards);
    }
    q.wrong -= 1;
    q.correct += 1;
    q.queue = q.queue.filter((it, i) => i <= q.index || it.cardId !== cur.item.cardId);
    q.lastOk = true;
    render();
  },
  next: () => { nextQuestion(); render(); },
  reveal: () => { state.quiz.revealed = true; render(); },
  'self-grade': (el) => { commitAnswer(el.dataset.ok === '1'); nextQuestion(); render(); },
  'mistake-filter': (el) => { state.mistakeFilter = state.mistakeFilter === el.dataset.cat ? 'all' : el.dataset.cat; render(); },
  'mistake-to-review': (el) => {
    const m = store.mistakes.find((x) => x.id === el.dataset.id);
    const cards = store.cards;
    cards.push({ id: uid(), kind: 'mistake', mistakeId: m.id, word: '', category: m.category, sentence: m.sentence, correctedSentence: m.correctedSentence, original: m.original, corrected: m.corrected, reason: m.reason, source: 'mistake', added: Date.now(), ...newCardState() });
    store.saveCards(cards);
    flash('復習に追加しました');
  },
  'confirm-ask': (el) => { state.confirm = el.dataset.key; render(); },
  'confirm-cancel': () => { state.confirm = null; render(); },
  'delete-slang': (el) => { store.saveSlang(store.slang.filter((s) => s.id !== el.dataset.id)); state.confirm = null; render(); },
  'delete-card': (el) => { store.saveCards(store.cards.filter((x) => x.id !== el.dataset.id)); state.confirm = null; render(); },
  'toggle-furigana': () => { store.saveSettings({ furigana: !store.settings.furigana }); render(); },
  clear: () => {
    store.clearAll();
    state.check.resultId = null;
    state.confirm = null;
    flash('記録を消しました');
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});

$app.addEventListener('submit', (e) => {
  const form = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.action === 'submit-reading') {
    const cur = currentItem();
    if (!cur || state.quiz.answered) return;
    const given = normalizeReading(data.reading);
    if (!given) return;
    const ok = given === cur.card.reading || (cur.card.accepted || []).includes(given);
    commitAnswer(ok);
    answerQuiz(ok, given);
    render();
  } else if (form.dataset.action === 'add-word') {
    const word = (data.word || '').trim();
    if (!word) return;
    if (!hasKanji(word)) { flash('漢字を含む言葉を入れてください'); return; }
    const reading = (data.reading || '').trim() || furi.readingOf(word) || '';
    if (!reading) { flash('読みを入れてください'); return; }
    if (addVocab({ word, reading, meaning: (data.meaning || '').trim() }, 'manual')) flash(`「${word}」を追加しました`);
    else flash('もう入っています');
  }
});

function onBind(e) {
  const key = e.target.dataset.bind;
  if (!key) return;
  // 日本語入力の変換中に描き直すと入力がこわれるので、確定を待つ
  if (e.isComposing) return;
  if (key === 'relationship') state.check.relationship = e.target.value;
  else if (key === 'draftContext' || key === 'draftText') state.check[key] = e.target.value;
  else if (key === 'editText') { if (state.editing) state.editing.text = e.target.value; }
  else if (key === 'quizFilter') state.quizFilter = e.target.value;
  else if (key === 'wordSearch') { state.wordSearch = e.target.value; render(); }
}

$app.addEventListener('input', onBind);
$app.addEventListener('compositionend', onBind);

$app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, Math.min(50, parseInt(el.value, 10) || 0)) : el.value;
    store.saveSettings({ [k]: v });
    if (k === 'relationship') state.check.relationship = v;
    render();
  } else if (el.dataset.action === 'pick-images') {
    const room = state.check.maxImages - state.check.images.length;
    const files = [...el.files].slice(0, Math.max(0, room));
    state.check.error = el.files.length > room ? `スクショは${state.check.maxImages}枚までです。` : null;
    try {
      const imgs = await Promise.all(files.map(prepareImage));
      state.check.images.push(...imgs);
    } catch (err) {
      state.check.error = err.message;
    }
    render();
  }
});

furi.onReady(render);
onStatus(render);

(async function start() {
  render();
  furi.init().catch(() => {});
  await initStore();
  state.check.relationship = store.settings.relationship;
  state.ready = true;
  render();
  const sample = await getSample();
  state.check.available = !!sample;
  state.check.maxImages = sample ? Math.min(5, await imageLimit()) : 0;
  render();
})();
