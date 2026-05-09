// Minimal app-shell service worker. Caches the built SPA assets on install so
// reconnect works after a brief network blip (Tailscale flap, captive portal,
// laptop sleep). Network-first for navigations so a fresh deploy lands on the
// next reload; cache-first for everything else (Vite content-hashes asset
// URLs so a deploy invalidates the cache automatically).
//
// We intentionally do NOT cache:
//   - WebSocket upgrades (/relay/...)
//   - Relay HTTP endpoints (/v1/...) — these depend on the bridge being live
//   - Cross-origin requests
//
// Update strategy: bump CACHE_VERSION on every visual/asset-shape change so
// stale rules don't outlive a deploy. The new worker activates on the next
// page load, purges old caches, and posts a "needs-reload" message to any
// open client that cares to listen.

const CACHE_VERSION = "agnt-web-v3";
const APP_SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const purged = keys.filter((key) => key !== CACHE_VERSION);
      await Promise.all(purged.map((key) => caches.delete(key)));
      await self.clients.claim();
      // If we evicted older caches, ping any open clients so they can show
      // a "new version available" affordance instead of silently serving a
      // mix of old + new chunks. The web app subscribes via
      // navigator.serviceWorker.addEventListener("message").
      if (purged.length > 0) {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({ kind: "agnt-cache-evicted", version: CACHE_VERSION });
        }
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/relay/") || url.pathname.startsWith("/v1/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/index.html");
    if (fallback) return fallback;
    throw new Error("offline and no cached shell");
  }
}
