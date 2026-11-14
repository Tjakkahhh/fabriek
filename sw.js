// App werkt zonder internet; kaarttegels die je al bekeken hebt blijven beschikbaar.
const SHELL = 'shell-v1', TILES = 'tiles-v1', MAX_TILES = 3000;
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'tile.opentopomap.org', 'tile.waymarkedtrails.org', 'cartoweb.wmts.ngi.be'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILES).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { // alleen leesbare antwoorden bewaren
        cache.put(e.request, res.clone());
        if (Math.random() < 0.02) trim(cache);
      }
      return res;
    }));
    return;
  }

  if (url.origin === location.origin) { // eerst netwerk voor verse versie, anders de bewaarde
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
