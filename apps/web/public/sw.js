// Minimal service worker. Its only job today is making the app installable.
//
// Deliberately no caching strategy: offline support (Phase 2) queues orders in
// IndexedDB with custom conflict rules, and a generic precache layer added now
// would only have to be unpicked then. This file is the hook that work lands in.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through. Required for installability; intentionally not intercepting.
self.addEventListener('fetch', () => {});
