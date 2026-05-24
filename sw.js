/* PublicCards Service Worker (§12) — cache-first app-shell, network-only API. */
const CACHE = 'publiccards-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icons/192.png',
  './icons/512.png',
  // CDN libs (CORS-enabled) so the shell also works offline
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))) // tolerate a failed CDN add
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never cache writes
  const url = new URL(req.url);

  // API requests: always network, never cache (§12).
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) return;

  // Drive images: network-first, fall back to cache.
  if (url.hostname.includes('drive.google.com')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // App shell + assets: cache-first, update cache in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && (url.origin === self.location.origin || url.hostname.includes('jsdelivr'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
