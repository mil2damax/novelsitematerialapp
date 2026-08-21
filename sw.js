// Service worker for the Site Materials static PWA.
// Caches the app shell so it opens offline; the clock-out reliability itself is
// handled by the IndexedDB queue in app.js. Supabase calls (cross-origin) are
// never cached — they always hit the network.

const CACHE = "site-materials-web-v1";
const SHELL = ["./", "index.html", "app.js", "styles.css", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Supabase calls pass through

  if (req.mode === "navigate") {
    // SPA: serve cached shell when the network is down.
    e.respondWith(fetch(req).catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
