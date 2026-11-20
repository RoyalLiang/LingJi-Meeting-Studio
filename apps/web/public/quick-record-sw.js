const shell = '/quick-record';
const name = 'lingji-quick-record-v2';
const isAsset = url => url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/brand/') || url.pathname === '/audio-worklet.js');

self.addEventListener('install', event => {
  event.waitUntil(caches.open(name).then(cache => cache.addAll([shell, '/audio-worklet.js'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lingji-quick-record-') && key !== name).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (!Array.isArray(event.data?.assets)) return;
  const urls = event.data.assets.slice(0, 80).filter(value => typeof value === 'string').map(value => new URL(value, self.location.origin)).filter(isAsset);
  event.waitUntil(caches.open(name).then(cache => Promise.allSettled(urls.map(url => cache.match(url.href).then(found => found || cache.add(url.href))))));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && url.pathname === shell) {
    event.respondWith(caches.open(name).then(async cache => {
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(shell, response.clone());
        return response;
      } catch {
        return await cache.match(shell) || Response.error();
      }
    }));
  } else if (isAsset(url)) {
    event.respondWith(caches.open(name).then(async cache => {
      const saved = await cache.match(event.request);
      if (saved) return saved;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }));
  }
});
