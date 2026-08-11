/**
 * Service worker for drpl.co
 *
 * Bump APP_VERSION alongside the ?v= strings in index.html. It keys the cache
 * and builds the precache URLs, so a deploy invalidates both at once.
 */
const APP_VERSION = "2.4.0";
const CACHE_NAME = `drpl-cache-${APP_VERSION}`;

// Scripts and styles must be precached under the exact URLs index.html asks
// for. Caching the bare path instead stores an entry that is never read: a
// cache lookup matches the query string, so "/scripts/ui.js" would never
// answer a request for "/scripts/ui.js?v=2.4.0".
const VERSIONED_ASSETS = [
  "/styles/styles.css",
  "/scripts/network.js",
  "/scripts/theme.js",
  "/scripts/background-animation.js",
  "/scripts/notifications.js",
  "/scripts/ui.js",
].map((path) => `${path}?v=${APP_VERSION}`);

const OFFLINE_URL = "/offline.html";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  OFFLINE_URL,
  "/manifest.json",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/images/favicon.png?v=4",
  "/fonts/figtree-latin-var.woff2",
  "/sent.mp3",
  ...VERSIONED_ASSETS,
];

// JS and CSS are network-first so deploys take effect on next load
const NETWORK_FIRST_PATTERNS = [/\/scripts\//, /\/styles\//];

function isNetworkFirst(url) {
  return NETWORK_FIRST_PATTERNS.some((pattern) => pattern.test(url));
}

function isNavigationRequest(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" &&
      request.headers.get("accept") &&
      request.headers.get("accept").includes("text/html"))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // The offline page is the one asset worth failing the install over.
      // The rest are best effort, so a single 404 cannot leave the app with
      // no service worker at all.
      .then((cache) =>
        cache.add(OFFLINE_URL).then(() =>
          Promise.allSettled(
            STATIC_ASSETS.filter((url) => url !== OFFLINE_URL).map((url) =>
              cache.add(url),
            ),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/server"))
    return;

  const url = event.request.url;

  if (isNetworkFirst(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request.clone())
        .then((response) => {
          if (
            !response ||
            response.status !== 200 ||
            response.type !== "basic"
          ) {
            return response;
          }
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => {
          if (isNavigationRequest(event.request)) {
            return caches
              .match(OFFLINE_URL)
              .then((r) => r || caches.match("/index.html"))
              .then(
                (r) =>
                  r ||
                  new Response(
                    "<html><body><h1>You are offline</h1></body></html>",
                    { status: 503, headers: { "Content-Type": "text/html" } },
                  ),
              );
          }
          return new Response("Network error", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        });
    }),
  );
});
