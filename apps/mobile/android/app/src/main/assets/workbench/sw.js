/*
 * Kill-switch service worker for local Cesium builds.
 *
 * Browsers previously controlled by a generated next-pwa worker can keep
 * serving stale HTML after rebuilds. That stale shell then points at chunk
 * hashes that no longer exist and the app freezes on the SSR auth splash.
 *
 * This worker claims the same scope, clears all caches, unregisters itself,
 * and forces open tabs to reload onto the fresh non-PWA app.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {}

    try {
      await self.registration.unregister();
    } catch {}

    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        try {
          client.navigate(client.url);
        } catch {}
      }
    } catch {}
  })());
});

self.addEventListener('fetch', () => {
  // Intentionally no caching.
});
