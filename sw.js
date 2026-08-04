// Service worker for Temple Runner.
//
// Deliberately dumb: an explicit precache list, cache-first, no runtime
// caching. Everything the game needs is known ahead of time, so there is
// nothing to be clever about and plenty to get wrong.
//
// To ship an update: bump VERSION. That is the entire release process.

const VERSION = 'v10';
const CACHE = `temple-runner-${VERSION}`;

// All relative — this worker's scope is /kenclarkzpage/, not the domain root.
const ASSETS = [
  'game.html',
  'manifest.webmanifest',
  'css/game.css',
  // three.module.min.js imports three.core.min.js by relative path. Omitting
  // the core file works fine online and gives a blank screen offline.
  'vendor/three/three.module.min.js',
  'vendor/three/three.core.min.js',
  'js/game/three.js',
  'js/game/config.js',
  'js/game/save.js',
  'js/game/skins.js',
  'js/game/audio.js',
  'js/game/geo.js',
  'js/game/textures.js',
  'js/game/path.js',
  'js/game/track.js',
  'js/game/atmosphere.js',
  'js/game/entities.js',
  'js/game/player.js',
  'js/game/monster.js',
  'js/game/input.js',
  'js/game/hud.js',
  'js/game/pwa.js',
  'js/game/main.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon-180.png',
];

// Resolved once so the fetch handler can compare pathnames cheaply.
const OWNED = new Set(ASSETS.map((a) => new URL(a, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache:'reload' bypasses the HTTP cache, so a redeploy actually picks up
      // the new bytes instead of re-caching whatever the CDN still holds.
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A worker registered at the repo root has scope over the whole site,
  // including index.html and its Bootstrap/jQuery assets. Scope cannot be
  // narrowed below the worker's own directory and GitHub Pages cannot set
  // Service-Worker-Allowed, so the filter belongs here: anything the game does
  // not own goes straight to the network, untouched.
  if (!OWNED.has(url.pathname)) return;

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
