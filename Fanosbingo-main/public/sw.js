/*
  የኛ bingo does NOT use a service worker.

  The original project shipped a service worker that queued POST requests to the
  edge functions while offline and returned a fake { success: true } response,
  replaying them later. For a real-money app that is unsafe (double submits /
  false confirmations), so it has been removed.

  This stub exists only to unregister any service worker a previous deployment
  installed in a returning user's browser, and to drop its caches.
*/
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.navigate(c.url));
    })(),
  );
});
