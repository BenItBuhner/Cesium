const CACHE_VERSION = "v1";
const CACHE_PREFIX = "opencursor-ipad-resume-";
const APP_SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const STATIC_PATH_PREFIXES = ["/_next/static/"];
const STATIC_PATHS = new Set([
  "/favicon.ico",
  "/manifest.json",
  "/icon-192x192.png",
  "/icon-512x512.png",
  "/apple-touch-icon.png",
]);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(CACHE_PREFIX) &&
                name !== APP_SHELL_CACHE &&
                name !== STATIC_CACHE
            )
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, APP_SHELL_CACHE));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
  }
});

function isStaticAsset(url) {
  return (
    STATIC_PATHS.has(url.pathname) ||
    STATIC_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cached ?? (await networkPromise) ?? fetch(request);
}
