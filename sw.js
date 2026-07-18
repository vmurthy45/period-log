/* Period Log service worker — precache the app shell so it opens with zero signal. */
const CACHE = "periodlog-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (ev) => {
  if (ev.request.method !== "GET") return;
  ev.respondWith(
    caches.match(ev.request, { ignoreSearch: true }).then((hit) =>
      hit ||
      fetch(ev.request).then((res) => {
        const copy = res.clone();
        if (res.ok && new URL(ev.request.url).origin === location.origin) {
          caches.open(CACHE).then((c) => c.put(ev.request, copy));
        }
        return res;
      }).catch(() => (ev.request.mode === "navigate" ? caches.match("./index.html") : undefined))
    )
  );
});
