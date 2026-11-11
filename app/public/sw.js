// Offline app shell. Same-origin GETs only: guest network traffic and
// runtime engines from other origins are never cached or intercepted.
const CACHE = "aether-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Hashed build assets never change: cache-first. Everything else (index.html,
  // manifest, Nodepod's worker) is network-first so deploys take effect.
  const immutable = url.pathname.includes("/assets/");
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (immutable) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: !immutable });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
