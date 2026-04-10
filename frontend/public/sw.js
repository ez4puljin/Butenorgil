// Minimal Service Worker — PWA суулгахад хэрэгтэй
const CACHE = "erp-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Network-first: цэлхий онлайн хэвтэй ажиллана, cache зөвхөн offline нөөц
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
