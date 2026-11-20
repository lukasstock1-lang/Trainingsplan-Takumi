// Service Worker: Offline-Fähigkeit und Push-Nachrichten.
// Bei Änderungen an den App-Dateien die Versionsnummer erhöhen.
const CACHE = 'takumi74-v2';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/api.js',
  './js/app.js',
  './js/config.js',
  './js/data.js',
  './js/dates.js',
  './js/icons.js',
  './js/notify.js',
  './js/schedule.js',
  './js/store.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/badge-72.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Netzwerk zuerst (immer aktuell), Cache als Rückfall für offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // API-Anfragen nie zwischenspeichern – Daten kommen immer frisch vom Server.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});

// Push-Nachricht vom Server.
// Format: { "title": "...", "body": "...", "tag": "...", "url": "./" }
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Takumi 74', {
        body: data.body || '',
        tag: data.tag,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-72.png',
        data: { url: data.url || './' },
      }),
      // Offene App sofort aktualisieren
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: 'refresh' }))),
    ]),
  );
});

// Tippen auf die Benachrichtigung öffnet die App.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
