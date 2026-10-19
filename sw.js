/* =========================================================
   ANIRUDH AGENCY — Service Worker (sw.js)
   100% Offline Progressive Web App Caching Engine
   ========================================================= */

const CACHE_NAME = 'order2invoice-v2.3.2';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './xlsx.full.min.js',
  './qrcode.min.js',
  './manifest.json',
  './Shop_Items.xlsx',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png'
];

// Install: Pre-cache all core app assets for instant offline execution
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn(`[ServiceWorker] Could not pre-cache: ${asset}`, err);
          })
        )
      );
    })
  );
});

// Activate: Clean up old versions of cache and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log(`[ServiceWorker] Removing legacy cache: ${key}`);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-first for code assets (ensures immediate updates), Cache-first for vendor libs/icons
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Network-only for live APIs
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for navigation & core application code (app.js, style.css, index.html)
  const isAppCode = event.request.mode === 'navigate' ||
                    url.pathname.endsWith('/app.js') ||
                    url.pathname.endsWith('/style.css') ||
                    url.pathname.endsWith('/index.html') ||
                    url.pathname === '/';

  if (isAppCode) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            return cached || (event.request.mode === 'navigate' ? (caches.match('./index.html') || caches.match('./')) : null);
          });
        })
    );
    return;
  }

  // Cache-first for heavy static assets (icons, xlsx library, fonts)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && url.origin === location.origin) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      });
    })
  );
});
