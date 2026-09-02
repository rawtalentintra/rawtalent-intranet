// v3 (2026-09-02) — KILL SWITCH.
//
// Joy: "It still saves as RT Partner... again." That's the "Add to Home
// Screen" dialog itself showing a stale name on what looks like a fresh
// visit — the strongest explanation left is that an OLDER copy of this
// service worker (v1, before /wfp was repointed at admin.html; possibly
// still v2) is already registered for this origin from an earlier visit
// and is still the one answering fetches, cache-first, for whatever it
// cached back then — independent of anything server.js or admin.html
// serve today, and independent of Safari's own HTTP cache (unaffected by
// "Clear Website Data" if that step got skipped or missed the SW).
//
// Rather than reason further about which exact old version is stuck and
// hope a cache-name bump alone races it out, this version doesn't try to
// cache or serve anything at all: it wipes every cache under this origin,
// unregisters itself, and forces every open tab/PWA window it controls to
// hard-reload straight to the network. After this activates once, there
// is no service worker left for /wfp — every load is a plain network
// fetch of whatever admin.html actually contains right now, same as any
// other page in this app. (Re-adding a real cache-first SW later, if ever
// wanted back for the install-prompt criteria, should ship as v4+ with a
// fresh CACHE_NAME — never re-use wfp-shell-v1/v2.)
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
  );
});
