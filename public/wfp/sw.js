// Minimal service worker — just enough for Android's install-prompt
// criteria (a registered SW is one of them) and to make the app shell load
// instantly on repeat opens. Deliberately NOT an offline data layer — Joy
// confirmed "app-like installable, not full offline" for this feature, so
// every API call (/api/...) is a plain network passthrough with no cache
// fallback; only the shell's own static assets get cached.
const CACHE_NAME = 'wfp-shell-v1';
const SHELL_ASSETS = [
  '/wfp',
  '/wfp/manifest.json',
  '/wfp/icon-192.png',
  '/wfp/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls — always live, never a stale cached answer
  // (centre/booking data changes constantly; this app has no offline sync).
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
