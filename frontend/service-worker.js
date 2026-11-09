/**
 * Clockify — Service Worker (service-worker.js)
 *
 * Caches the application shell so the portal boots without connectivity and
 * serves an explicit offline screen for uncached routes. API responses are
 * never cached: attendance data must always come from the server.
 */

const CACHE_NAME = "clockify-shell-v1";

const APP_SHELL = [
  "/",
  "/admin",
  "/manifest.webmanifest",
  "/static/offline.html",
  "/static/css/style.css",
  "/static/css/admin.css",
  "/static/js/api.js",
  "/static/js/geo.js",
  "/static/js/queue.js",
  "/static/js/app.js",
  "/static/js/admin.js",
  "/static/icons/icon.svg",
  "/static/icons/icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live attendance data is network-only.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: fresh shell when possible, cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null);
          }
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request);
          if (cachedPage) return cachedPage;
          const shell = await caches.match("/");
          if (shell) return shell;
          return caches.match("/static/offline.html");
        })
    );
    return;
  }

  // Static assets: cache-first, fill the cache on first online load.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.ok && url.pathname.startsWith("/static/")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null);
        }
        return response;
      });
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
