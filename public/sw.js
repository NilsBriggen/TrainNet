// Service worker: makes the site installable (iPhones show notifications only to installed web apps). It caches
// nothing, so a deploy is never hidden behind stale files; push notifications for followed trips arrive here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
