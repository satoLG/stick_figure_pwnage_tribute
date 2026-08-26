/**
 * The smallest service worker that earns its keep: it makes the game start
 * offline once it has been played once, and nothing else.
 *
 * Vite fingerprints every built asset, so there is no list to precache that
 * would not go stale on the next deploy. Instead the shell is fetched fresh
 * whenever the network allows and served from cache when it does not, and the
 * fingerprinted assets - which can never change behind their own name - are
 * cached the first time they are asked for and served from there after.
 */
const CACHE = 'pwnage-v2';

// Every path is resolved against the worker's own URL, never against the host
// root: the game is just as likely to be served from a project subdirectory as
// from a domain of its own, and an absolute '/' would cache the wrong site.
const HERE = new URL('./', self.location.href);
const at = (path) => new URL(path, HERE).href;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png']
  .map(at);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => undefined)   // a missing file must not wedge the install
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Outside the worker's own directory is somebody else's business.
  if (!url.href.startsWith(HERE.href)) return;

  // Navigations: the network decides, the cache catches. Anything else would
  // pin a stale build on the device until it was uninstalled.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(at('./index.html'), copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(at('./index.html')).then((r) => r ?? Response.error())),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    })),
  );
});
