// アプリ本体はネット優先（更新がすぐ届くように）、ふりがな辞書はキャッシュ優先
const APP_CACHE = 'nihongo-app-v1';
const DICT_CACHE = 'nihongo-dict-v1';
const APP_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/store.js', 'js/furigana.js', 'js/claude.js', 'js/srs.js', 'js/kana.js', 'js/starter-vocab.js',
  'lib/anthropic-sdk.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP_CACHE && k !== DICT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/kuromoji@')) {
    e.respondWith(
      caches.open(DICT_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(APP_CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
