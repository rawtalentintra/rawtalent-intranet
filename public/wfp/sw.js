// Minimal service worker — just enough for Android's install-prompt
// criteria (a registered SW is one of them) and to make the app shell load
// instantly on repeat opens. Deliberately NOT an offline data layer — Joy
// confirmed "app-like installable, not full offline" for this feature, so
// every API call (/api/...) is a plain network passthrough with no cache
// fallback; only the shell's own static assets get cached.
// v2 (2026-09-02): /wfp now serves admin.html, not the old standalone
// shell — bumped so anyone with the old version already installed gets a
// clean cache instead of a stale mix of old/new entries under one name.
const CACHE_NAME = 'wfp-shell-v2';
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

  // /wfp itself (2026-09-02) now serves admin.html — the actively-
  // developed main app, not the small, rarely-changed standalone shell
  // this worker was first written for. Cache-first on that document would
  // mean an installed app keeps showing today's already-fixed bug until
  // CACHE_NAME is bumped by hand. Network-first for the document itself
  // (fall back to cache only if the network's actually unreachable);
  // manifest/icons — genuinely static — stay cache-first below.
  if (event.request.mode === 'navigate' || url.pathname === '/wfp') {
    event.respondWith(
      fetch(event.request)
        .then((res) => { caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone())); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
