// localStorage への保存（使えない環境ではメモリだけで動く）

const PREFIX = 'nihongo:';
const memory = {};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch {
    if (key in memory) return memory[key];
  }
  return key in memory ? memory[key] : fallback;
}

function write(key, value) {
  memory[key] = value;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 容量オーバーやプライベートモードではメモリにだけ残す
  }
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  relationship: '友達',
  furigana: true,
  newPerDay: 10,
  autoAddVocab: true,
  quizMode: 'auto',
};

export const KEYS = ['settings', 'history', 'cards', 'mistakes', 'slang', 'daily'];

export const store = {
  get settings() { return { ...DEFAULT_SETTINGS, ...read('settings', {}) }; },
  saveSettings(patch) { write('settings', { ...this.settings, ...patch }); },

  get history() { return read('history', []); },
  saveHistory(list) { write('history', list.slice(0, 100)); },

  get cards() { return read('cards', []); },
  saveCards(list) { write('cards', list); },

  get mistakes() { return read('mistakes', []); },
  saveMistakes(list) { write('mistakes', list.slice(0, 1000)); },

  get slang() { return read('slang', []); },
  saveSlang(list) { write('slang', list); },

  // 1日の新しい語の数を数える
  get daily() { return read('daily', { date: '', newCount: 0 }); },
  saveDaily(d) { write('daily', d); },

  exportAll() {
    const data = {};
    for (const k of KEYS) data[k] = read(k, null);
    if (data.settings) data.settings = { ...data.settings, apiKey: '' };
    return data;
  },
  importAll(data) {
    for (const k of KEYS) {
      if (k === 'settings') continue;
      if (data[k] != null) write(k, data[k]);
    }
  },
  clearAll() {
    for (const k of KEYS) {
      delete memory[k];
      try { localStorage.removeItem(PREFIX + k); } catch { /* ignore */ }
    }
  },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
