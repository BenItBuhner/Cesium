/**
 * Browser Machine preview service worker.
 *
 * The in-page engine publishes built/static workspace files into the
 * `cesium-browser-machine-preview` cache; this worker serves them under
 * `/preview/<workspace-slug>/...` so previews load as a normal same-origin
 * static site with zero backend.
 */
const PREVIEW_CACHE_NAME = "cesium-browser-machine-preview";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/preview/")) {
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(PREVIEW_CACHE_NAME);
      const exact = await cache.match(url.origin + url.pathname);
      if (exact) return exact;
      // Directory URL → index.html fallback.
      const withSlash = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      const index = await cache.match(url.origin + withSlash + "index.html");
      if (index) return index;
      const asDir = await cache.match(url.origin + withSlash);
      if (asDir) return asDir;
      return new Response(
        "Preview not found. Publish it from the browser machine shell with: serve <dir>",
        { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    })()
  );
});
