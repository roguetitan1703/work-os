// Work OS service worker: makes the app installable and keeps a usable shell offline.
// Pages are network-first (data is live); built assets are cache-first; offline shows /offline.html.
const VERSION = 'v2';
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

// ── Push notifications ──────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'Work OS', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Work OS', {
      body: data.body || '',
      icon: '/icons/192',
      badge: '/icons/192',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/notifications', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then(c => c.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
