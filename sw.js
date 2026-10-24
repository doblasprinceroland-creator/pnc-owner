// PNC Owner: caches the page itself so the home-screen app opens instantly.
// Data (ntfy.sh) is never cached: every number comes fresh from the network.
const CACHE = "pnc-owner-v3";
const SHELL = [
  "./",
  "index.html",
  "style.css?v=3",
  "app.js?v=3",
  "manifest.webmanifest",
  "icons/pnc-logo.webp",
  "icons/pnc-logo.png",
  "icons/pnc-icon-64.png",
  "icons/pnc-icon-180.png",
  "icons/pnc-icon-192.png",
  "fonts/unbounded-latin.woff2",
  "fonts/spacegrotesk-latin.woff2",
  "fonts/spacegrotesk-latin-ext.woff2",
  "fonts/plusjakartasans-latin.woff2",
  "fonts/plusjakartasans-latin-ext.woff2"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin files: network first (so updates show up), cache when offline.
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./")))
  );
});
