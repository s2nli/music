/* Codexstudys Music — service worker (single worker for the whole app) */
var VERSION = "v2";
var CACHE = "codexstudys-music-" + VERSION;
var PAGES = ["/", "/genres", "/insights", "/library", "/liked", "/downloads", "/playlists"];
var RSC = ["/rsc/index.txt", "/rsc/genres.txt", "/rsc/insights.txt", "/rsc/library.txt", "/rsc/liked.txt", "/rsc/downloads.txt", "/rsc/playlists.txt"];
var STATIC = ["/cx-shell.js", "/cx.css", "/manifest.webmanifest", "/favicon.ico", "/icons/logo-mark-128.png", "/icons/icon-192.png"];
var SHELL = PAGES.concat(RSC, STATIC);

function precache() {
  return caches.open(CACHE).then(function (c) {
    // pages first, so we can discover the hashed build assets they reference
    return Promise.all(PAGES.concat(RSC).map(function (u) {
      return fetch(u, { cache: "reload" }).then(function (r) {
        if (!r.ok) return "";
        c.put(u, r.clone());
        return r.text();
      }).catch(function () { return ""; });
    })).then(function (texts) {
      var assets = {};
      texts.join("\n").replace(/\/?_next\/static\/[A-Za-z0-9_\-.\/]+\.(?:js|css)/g, function (m) { assets[m.charAt(0) === "/" ? m : "/" + m] = 1; });
      var list = Object.keys(assets).concat(STATIC);
      return Promise.all(list.map(function (u) { return c.add(u).catch(function () {}); }));
    });
  });
}

self.addEventListener("install", function (e) { e.waitUntil(precache().then(function () { return self.skipWaiting(); })); });

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // drops every cache that is not the current one (including caches from earlier app versions)
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "cx-precache") e.waitUntil(precache());
  if (e.data && e.data.type === "skip-waiting") self.skipWaiting();
});

function networkFirst(req, fallbackUrl) {
  return fetch(req).then(function (r) {
    if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return r;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      if (fallbackUrl) return caches.match(fallbackUrl);
      return Response.error();
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.headers.has("range")) return;          // let the browser handle media ranges
  var p = url.pathname;
  if (p === "/sw.js") return;

  if (p.indexOf("/_next/static/") === 0 || p.indexOf("/icons/") === 0) { e.respondWith(networkFirst(req)); return; }
  if (p === "/cx-shell.js" || p === "/manifest.webmanifest" || p === "/favicon.ico") {
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r.ok) { var c = r.clone(); caches.open(CACHE).then(function (k) { k.put(req, c); }); } return r; }).catch(function () { return hit; });
      return hit || net;
    }));
    return;
  }
  if (p.indexOf("/rsc/") === 0) { e.respondWith(networkFirst(req)); return; }
  if (req.mode === "navigate") {
    // offline navigation falls back to the Downloaded Songs page (playable without internet)
    e.respondWith(networkFirst(req, "/downloads"));
    return;
  }
});
