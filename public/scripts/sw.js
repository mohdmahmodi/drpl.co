// Service Worker for drpl.co
const CACHE_NAME = "drpl-cache-v8";

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
  "/images/favicon.png",
  "/manifest.json",
];

// Assets that should ALWAYS be fetched fresh from the network first.
// FIX: JS and CSS are network-first so version bumps take effect immediately
// without requiring users to manually clear cache.
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

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[SW] Installing");
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        // Cache offline page first, then the rest
        return cache
          .add("/offline.html")
          .catch(() => cache.add("offline.html"))
          .then(() =>
            Promise.allSettled(
              STATIC_ASSETS.filter((u) => !u.includes("offline.html")).map(
                (u) => cache.add(u),
              ),
            ),
          );
      })
      .then(() => self.skipWaiting()),
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating");
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

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/server"))
    return;

  const url = event.request.url;

  // FIX: Network-first for JS and CSS — ensures updates are picked up immediately
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
        .catch(() => caches.match(event.request)), // Fall back to cache if offline
    );
    return;
  }

  // Cache-first for everything else (images, fonts, HTML)
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
          // Offline fallback for navigation requests
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
