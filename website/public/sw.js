// Service worker: caches the app shell so SyncSafe opens with no network.
// Strategy: network first (always get the latest code when online), cache as fallback.
// API calls are never cached; offline data lives in IndexedDB instead.
const CACHE = 'syncsafe-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/ai.js',
  '/js/api.js',
  '/js/app.js',
  '/js/core.js',
  '/js/i18n.js',
  '/js/lang/en.js',
  '/js/lang/hi.js',
  '/js/lang/te.js',
  '/js/native.js',
  '/js/repository.js',
  '/js/secure.js',
  '/js/store.js',
  '/js/sync-engine.js',
  '/js/textcrdt.js',
  '/js/theme.js',
  '/js/ui.js',
  '/js/views/activity.js',
  '/js/views/admin.js',
  '/js/views/conflicts.js',
  '/js/views/editor.js',
  '/js/views/map.js',
  '/js/views/records.js',
  '/js/views/reports.js',
  '/vendor/images/layers-2x.png',
  '/vendor/images/layers.png',
  '/vendor/images/marker-icon-2x.png',
  '/vendor/images/marker-icon.png',
  '/vendor/images/marker-shadow.png',
  '/vendor/leaflet.css',
  '/vendor/leaflet.js',
  '/vendor/yjs.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/metrics') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      }),
  );
});
