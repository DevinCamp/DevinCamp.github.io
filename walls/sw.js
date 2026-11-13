// Caches the app shell so it opens instantly; market data always comes live from Coinbase.
const CACHE = "walls-v7";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;               // never cache Coinbase data
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});

// Push alerts from the user's relay (▲ / ▼ order-book signals)
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Walls alert", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Walls alert", {
    body: d.body || "", tag: d.tag || "walls", renotify: true, icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  }));
});
