/* build: 65bd17d798ac — content hash, auto-stamped by deploy.py; a changed stamp forces phones to reinstall the SW and re-precache all content */
/* ============================================================
   sw.js — Service Worker (network-first everywhere)

   ONLINE  → every request goes to the server first, and the
             response refreshes the offline cache. You always
             see the latest files, no version bumps needed.
   OFFLINE → everything serves from the cache, which holds a
             full copy of the app (precached on install from
             precache-list.json, refreshed on every fetch).
============================================================ */

const CACHE_NAME = 'phone-os';

/* ---- Install: precache the full asset list for offline use ----
   Robust: 6 fetches at a time, 10s timeout each, 90s cap overall.
   A slow or hung file can never block install — anything missed
   gets cached at runtime on first use. ---- */
async function precacheAll() {
  const res  = await fetch('./precache-list.json?v=' + Date.now());
  const list = await res.json();
  const cache  = await caches.open(CACHE_NAME);
  const queue  = (list.assets || []).slice();
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (r && r.status === 200) await cache.put(url, r);
      } catch (e) { /* skip — runtime caching will pick it up */ }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await Promise.race([
      precacheAll().catch(() => {}),
      new Promise(r => setTimeout(r, 90000)),
    ]);
    await self.skipWaiting();
  })());
});

/* ---- Activate: claim clients, clean up old versioned caches ---- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---- Fetch strategy ----
   Immutable assets (fonts, images, audio) → cache-first: they never
   change, so never wait on the network for them.
   Everything else (html/json/js)         → network-first with a 3s
   timeout racing the cache. On set Wi-Fi that is connected-but-dead,
   a plain fetch can hang for 30s+ before erroring — the timeout makes
   the app fall back to the cached copy almost immediately. If nothing
   is cached yet (first visit on a slow network), retry the network
   without the timeout rather than failing. ---- */
const STATIC_EXT = /\.(png|jpe?g|webp|svg|gif|otf|ttf|woff2?|mp3|wav)$/i;
const NETWORK_TIMEOUT_MS = 3000;

async function cachePut(request, response) {
  if (response && response.status === 200 && response.type !== 'opaque') {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin

  // Cache-first for immutable assets
  if (STATIC_EXT.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await cachePut(event.request, await fetch(event.request));
      } catch (err) {
        return new Response('Offline — resource not cached', { status: 503 });
      }
    })());
    return;
  }

  // Network-first (with timeout) for html/json/js
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
      return await cachePut(event.request, response);
    } catch (err) {
      // Timed out or offline → serve from cache (ignore ?query cache-busters)
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      // Navigations fall back to the app shell
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      // Nothing cached — give the slow network a real chance
      try {
        return await cachePut(event.request, await fetch(event.request));
      } catch (err2) {
        return new Response('Offline — resource not cached', { status: 503 });
      }
    }
  })());
});
