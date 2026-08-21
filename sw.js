/* Cache offline: la app funciona sin internet una vez abierta la primera vez. */
const CACHE = "cartera-v3";
const ARCHIVOS = [
  "./", "./index.html", "./manifest.webmanifest", "./icono.svg",
  "./src/app.js?v=3", "./src/modelo.js?v=3", "./src/parsers.js?v=3", "./src/cotizaciones.js?v=3",
  "./src/ccl.json", "./src/precios.json",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;      // cotizaciones: siempre a la red
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
