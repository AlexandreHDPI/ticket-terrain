// Service worker minimal : permet à la page technicien de s'ouvrir même sans
// réseau (les tickets créés hors-ligne sont mis en file d'attente côté page,
// via IndexedDB, et envoyés automatiquement au retour de la connexion).
const CACHE_NAME = "tickets-hdpi-v2";
const APP_SHELL = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/theme.js",
  "/static/manifest.json",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/favicon-32.png",
  "/static/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // les envois de tickets (POST/PUT/DELETE) passent tels quels

  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/photos/") || url.pathname.startsWith("/admin")) {
    return; // toujours en direct depuis le réseau, jamais depuis le cache
  }

  // La page HTML elle-même (navigation) : toujours privilégier le réseau
  // pour que les mises à jour de l'application (nouveaux champs, etc.)
  // soient visibles immédiatement. Le cache ne sert que si le réseau est
  // indisponible (vrai mode hors-ligne).
  const isNavigation = req.mode === "navigate" || req.destination === "document";
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Fichiers statiques (CSS/JS/icônes) : affichage immédiat depuis le cache
  // si présent, avec mise à jour en arrière-plan pour la prochaine visite.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
