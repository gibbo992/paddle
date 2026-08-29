// Service worker: cache the shell so the app opens instantly and still works
// with no signal. Forecast data is cached separately in localStorage by api.js —
// deliberately not here, because a stale forecast served silently from a cache
// is worse than one the app knows is stale and can label.

const VERSION = 'v1';
const SHELL = `ksc-shell-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/api.js',
  'js/calendar.js',
  'js/craft.js',
  'js/demo.js',
  'js/kit.js',
  'js/icons.js',
  'js/rivers.js',
  'js/scoring.js',
  'js/settings-ui.js',
  'js/spots.js',
  'js/store.js',
  'js/tide.js',
  'js/ui.js',
  'js/util.js',
  'js/windows.js',
  'manifest.webmanifest',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // addAll is all-or-nothing; tolerate one asset 404ing rather than
      // leaving the app with no cache at all.
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache the APIs — the forecast must be live or explicitly labelled stale.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, so a deployed update is picked up straight away.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
