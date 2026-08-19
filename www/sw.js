const CACHE = "dub-siren-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
// Core app files: always try the network first so an update shows up on the
// very next load instead of waiting on a stale cache. Everything else
// (icons, manifest) is cache-first since it rarely changes.
const NETWORK_FIRST = new Set(["./", "./index.html", "./style.css", "./app.js"]);

function pathOf(request){
  const url = new URL(request.url);
  const rel = url.pathname.replace(/^.*\/portable-siren\//, "./").replace(/^\/+/, "./");
  return rel === "./" || rel.endsWith("/") ? "./" : rel;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const key = pathOf(event.request);

  if (NETWORK_FIRST.has(key)){
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
