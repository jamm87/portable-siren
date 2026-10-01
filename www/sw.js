const CACHE = "dub-siren-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./guide.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
// Core app files: always try the network first so an update shows up on the
// very next load instead of waiting on a stale cache. Everything else
// (icons, manifest) is cache-first since it rarely changes.
const NETWORK_FIRST = new Set(["./", "./index.html", "./style.css", "./app.js"]);

// Resolve against the worker's own scope rather than a hardcoded repo path:
// the app has to keep working whether it is served from /portable-siren/app/,
// from a custom domain's root, or anywhere else.
const SCOPE = new URL("./", self.registration.scope).pathname;
function pathOf(request){
  const path = new URL(request.url).pathname;
  const rel = "./" + (path.startsWith(SCOPE) ? path.slice(SCOPE.length) : path.replace(/^\/+/, ""));
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
