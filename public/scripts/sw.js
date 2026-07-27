// Service worker for drpl.co
const CACHE_NAME = "drpl-cache-v11";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/offline.html",
  "/styles/styles.css",
  "/scripts/ui.js",
  "/scripts/network.js",
  "/scripts/theme.js",
  "/scripts/background-animation.js",
  "/scripts/notifications.js",
  "/fonts/figtree-latin-var.woff2",
  "/images/favicon.png",
  "/manifest.json",
  "/sent.mp3",
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
      .then((cache) =>
        cache
          .add("/offline.html")
          .catch(() => cache.add("offline.html"))
          .then(() =>
            Promise.allSettled(
              STATIC_ASSETS.filter((u) => !u.includes("offline.html")).map(
                (u) => cache.add(u),
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
              .match("/offline.html")
              .then((r) => r || caches.match("offline.html"))
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
