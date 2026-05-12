// Minimal Service Worker — PWA-д шаардлагатай байгаа учраас үлдсэн.
//
// Цаг тутам шинэ build хийгдэхэд хуучин кэш барих ёсгүй учир:
//   1. install үед skipWaiting() — шинэ SW шууд идэвхтэй болно
//   2. activate үед хуучин кэш бүгдийг устгана
//   3. fetch — index.html, /assets/*.js, /assets/*.css, sw.js нар network-only
//      (cache-аас огт уншихгүй, шинэ build харагдахгүй болохоос сэргийлнэ)
//
// CACHE_VERSION-ыг шинэ build бүрт өөрчилнө гэхдээ бид дотроо ямар ч URL
// кэшэлдэггүй учир өөрчлөх хатуу шаардлагагүй. Гэхдээ хуучин SW-уудын
// үлдээсэн кэш дэндүү байгаа тохиолдолд activate үед цэвэрлэгдэнэ.
const CACHE_VERSION = "erp-v2";

self.addEventListener("install", () => {
  // Шинэ SW-ыг хүлээлгүй идэвхжүүлнэ
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Хуучин кэшийг бүхэлд нь устгана — хэн ч хуучин index.html-ийг харахгүй
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // Бүх client-ийг шууд авч ажиллана
    await self.clients.claim();
    // Нээлттэй бүх таб-уудыг шинэчлэх дохио өгнө
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => c.postMessage({ type: "SW_UPDATED" }));
  })());
});

// Бүх GET request-ыг network-аас шууд авна. SW нь огт кэш үүсгэхгүй.
// Хэрэв сүлжээ тасрах үед — браузер өөрийн HTTP cache-аас уншина (хэрвээ байвал).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request));
});
