// Work OS service worker: makes the app installable and keeps a usable shell offline.
// Pages are network-first (data is live); built assets are cache-first; offline shows /offline.html.
const VERSION = 'v1';
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(STATIC).then(c => c.addAll(['/offline.html', '/icons/192'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => ![STATIC, PAGES].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(STATIC).then(async c => (await c.match(req)) || c.put(req, (await fetch(req)).clone()).then(() => c.match(req))));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && !res.redirected) caches.open(PAGES).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(req)) || caches.match('/offline.html')),
    );
  }
});
