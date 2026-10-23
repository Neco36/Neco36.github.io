// 学習の記録の保存。
// claude.ai の中で開いたときは、その人専用のデータベース（data/users/<id>/）に保存して、
// ほかの端末でも同じ記録を使えるようにする。使えないときはこのブラウザの中に保存する。

const PREFIX = 'nihongo:';
const LIST_KEYS = ['history', 'cards', 'mistakes', 'slang'];
const OBJ_KEYS = ['settings', 'daily'];
export const KEYS = [...OBJ_KEYS, ...LIST_KEYS];

// 1つのドキュメントは 256 KiB まで。余裕をもって 180 KB ごとに分ける
const CHUNK_BYTES = 180 * 1024;
const enc = new TextEncoder();

export const DEFAULT_SETTINGS = {
  relationship: '友達',
  furigana: true,
  newPerDay: 10,
  autoAddVocab: true,
  quizMode: 'auto',
};

const mem = {};
const written = {};     // ドキュメント id → 最後に書いた JSON
const chunkCount = {};  // リストのキー → 今あるドキュメントの数
const timers = {};
const busy = {};
const again = {};
let db = null;
let userId = null;
let status = { mode: 'loading', message: '' };
const listeners = new Set();

function localRead(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function localWrite(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // プライベートモードや容量オーバーではメモリにだけ残す
  }
}

function setStatus(mode, message = '') {
  status = { mode, message };
  listeners.forEach((fn) => fn(status));
}

export function onStatus(fn) {
  listeners.add(fn);
}

export function storageStatus() {
  return status;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function get(key, fallback) {
  return key in mem && mem[key] != null ? clone(mem[key]) : fallback;
}

function put(key, value) {
  mem[key] = clone(value);
  localWrite(key, mem[key]);
  schedule(key);
}

// ---- データベースとのやりとり ----

function docRef(id) {
  return db.collection(`data/users/${userId}`).doc(id);
}

function chunks(items) {
  const out = [[]];
  let size = 0;
  for (const it of items) {
    const n = enc.encode(JSON.stringify(it)).length + 1;
    if (size + n > CHUNK_BYTES && out[out.length - 1].length) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1].push(it);
    size += n;
  }
  return out;
}

async function writeDoc(id, body) {
  const json = JSON.stringify(body);
  if (written[id] === json) return;
  try {
    await docRef(id).set(body);
  } catch (e) {
    if (e && e.code === 'unavailable') {
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      await docRef(id).set(body);
    } else {
      throw e;
    }
  }
  written[id] = json;
}

async function writeKey(key) {
  const value = mem[key];
  if (OBJ_KEYS.includes(key)) {
    await writeDoc(key, { v: value ?? null });
    return;
  }
  const parts = chunks(value || []);
  for (let i = 0; i < parts.length; i++) {
    await writeDoc(`${key}-${i}`, { items: parts[i], count: parts.length });
  }
  for (let i = parts.length; i < (chunkCount[key] || 0); i++) {
    await docRef(`${key}-${i}`).delete();
    delete written[`${key}-${i}`];
  }
  chunkCount[key] = parts.length;
}

function schedule(key) {
  if (!db) return;
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => flush(key), 400);
}

async function flush(key) {
  if (!db) return;
  if (busy[key]) { again[key] = true; return; }
  busy[key] = true;
  try {
    await writeKey(key);
  } catch (e) {
    const code = e && e.code;
    if (code === 'quota_exceeded') {
      setStatus('cloud', '保存できる量がいっぱいです。古い履歴を消してください。');
    } else {
      // 書き込めない（招待の権限が「閲覧」だけ など）ときは、この端末に保存する
      db = null;
      setStatus('local', '記録はこの端末の中だけに保存されます。');
    }
  } finally {
    busy[key] = false;
    if (again[key]) { again[key] = false; flush(key); }
  }
}

export async function initStore() {
  for (const k of KEYS) mem[k] = localRead(k);
  const claude = window.claude;
  if (!claude || typeof claude.use !== 'function') {
    setStatus('local', '記録はこの端末の中だけに保存されます。');
    return;
  }
  try {
    const [d, u] = await Promise.all([claude.use('db'), claude.use('user')]);
    const id = u ? await u.id() : null;
    if (!d || !id) {
      setStatus('local', '記録はこの端末の中だけに保存されます。');
      return;
    }
    db = d;
    userId = id;
    const snap = await db.collection(`data/users/${userId}`).get();
    const cloud = {};
    const lists = {};
    for (const doc of snap.docs) {
      const body = doc.data() || {};
      written[doc.id] = JSON.stringify(body);
      if (OBJ_KEYS.includes(doc.id)) {
        cloud[doc.id] = body.v;
        continue;
      }
      const m = /^([a-z]+)-(\d+)$/.exec(doc.id);
      if (m && LIST_KEYS.includes(m[1])) (lists[m[1]] = lists[m[1]] || []).push({ n: +m[2], body });
    }
    for (const [key, parts] of Object.entries(lists)) {
      parts.sort((a, b) => a.n - b.n);
      const count = (parts.find((p) => p.n === 0) || {}).body?.count ?? parts.length;
      chunkCount[key] = Math.max(count, parts.length);
      cloud[key] = parts.filter((p) => p.n < count).flatMap((p) => p.body.items || []);
    }
    const hasCloud = Object.keys(cloud).length > 0;
    if (hasCloud) {
      // クラウドの記録を正とする
      for (const k of KEYS) {
        mem[k] = k in cloud ? cloud[k] : null;
        localWrite(k, mem[k]);
      }
    } else {
      // はじめてのとき：この端末の記録があればクラウドへ移す
      for (const k of KEYS) if (mem[k] != null) schedule(k);
    }
    setStatus('cloud');
  } catch (e) {
    console.warn('データベースを使えませんでした', e);
    db = null;
    setStatus('local', '記録はこの端末の中だけに保存されます。');
  }
}

export const store = {
  get settings() { return { ...DEFAULT_SETTINGS, ...get('settings', {}) }; },
  saveSettings(patch) { put('settings', { ...this.settings, ...patch }); },

  get history() { return get('history', []); },
  saveHistory(list) { put('history', list.slice(0, 100)); },

  get cards() { return get('cards', []); },
  saveCards(list) { put('cards', list); },

  get mistakes() { return get('mistakes', []); },
  saveMistakes(list) { put('mistakes', list.slice(0, 1000)); },

  get slang() { return get('slang', []); },
  saveSlang(list) { put('slang', list); },

  get daily() { return get('daily', { date: '', newCount: 0 }); },
  saveDaily(d) { put('daily', d); },

  clearAll() {
    for (const k of KEYS) put(k, OBJ_KEYS.includes(k) ? null : []);
  },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
