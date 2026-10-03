/*!
 * Codexstudys Music — app shell runtime
 * Loaded in <head> on every page (before React). Responsibilities:
 *  - legacy storage migration (old key prefix / old downloads DB)
 *  - PWA: service worker registration + install prompt capture
 *  - Downloaded songs store (IndexedDB) shared by the whole app
 *  - "Clear All Data" (the only code path that wipes persistent app data)
 *  - tiny toast helper
 */
(function () {
  "use strict";
  if (window.CX) return;

  var DB_NAME = "codexstudys-music";
  var STORE = "songs";
  var LEGACY_DB = "ayu-downloads";
  var LEGACY_PREFIX = "ayumusic_";
  var NEW_PREFIX = "cxm_";

  var CX = (window.CX = {});
  var listeners = {};
  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); }; }
  function emit(name, data) { (listeners[name] || []).slice().forEach(function (f) { try { f(data); } catch (e) {} }); try { window.dispatchEvent(new CustomEvent("cx:" + name, { detail: data })); } catch (e) {} }
  CX.on = on;

  /* ------------------------------------------------------------ toast */
  var toastEl, toastTimer;
  function toast(msg, kind) {
    try {
      if (!document.body) { document.addEventListener("DOMContentLoaded", function () { toast(msg, kind); }); return; }
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.setAttribute("role", "status");
        toastEl.setAttribute("aria-live", "polite");
        toastEl.style.cssText = "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 190px);transform:translate(-50%,12px);opacity:0;z-index:99999;max-width:min(92vw,420px);padding:10px 16px;border-radius:999px;background:rgba(20,20,24,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.12);color:#fff;font:600 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.02em;box-shadow:0 10px 40px rgba(0,0,0,.55);transition:opacity .2s ease,transform .2s ease;pointer-events:none;text-align:center";
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.borderColor = kind === "error" ? "rgba(248,113,113,.5)" : "rgba(255,255,255,.12)";
      requestAnimationFrame(function () { toastEl.style.opacity = "1"; toastEl.style.transform = "translate(-50%,0)"; });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; toastEl.style.transform = "translate(-50%,12px)"; }, 2600);
    } catch (e) {}
  }
  CX.toast = toast;

  /* ------------------------------------------- legacy localStorage keys */
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LEGACY_PREFIX) === 0) {
        var nk = NEW_PREFIX + k.slice(LEGACY_PREFIX.length);
        if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
        localStorage.removeItem(k);
      }
    }
  } catch (e) {}

  /* --------------------------------------------------------- IndexedDB */
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" }); };
      r.onsuccess = function () { var d = r.result; d.onversionchange = function () { d.close(); dbPromise = null; }; resolve(d); };
      r.onerror = function () { dbPromise = null; reject(r.error); };
      r.onblocked = function () {};
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return openDb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(q && q.result); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* ------------------------------------------------- downloaded songs */
  var ids = {};                 // id -> true (sync lookups for the player UI)
  var audioUrls = {};           // id -> blob: url (created lazily, revoked on remove)
  var coverUrls = {};
  var loaded = false;
  var dl = (CX.dl = {});

  function refreshIds() {
    return tx("readonly", function (s) { return s.getAllKeys(); }).then(function (keys) {
      ids = {}; (keys || []).forEach(function (k) { ids[k] = true; }); loaded = true; emit("downloads", { type: "sync" });
    }).catch(function () { loaded = true; });
  }
  dl.ready = function () { return loaded ? Promise.resolve() : refreshIds(); };
  dl.has = function (id) { return !!ids[String(id)]; };
  dl.count = function () { return Object.keys(ids).length; };
  dl.all = function () {
    return tx("readonly", function (s) { return s.getAll(); }).then(function (a) { return (a || []).sort(function (x, y) { return y.savedAt - x.savedAt; }); });
  };
  dl.get = function (id) { return tx("readonly", function (s) { return s.get(String(id)); }); };
  function coverUrl(rec) {
    if (!rec.cover) return "";
    if (!coverUrls[rec.id]) coverUrls[rec.id] = URL.createObjectURL(rec.cover);
    return coverUrls[rec.id];
  }
  // Rebuilds a player-ready track object from a stored record.
  dl.toTrack = function (rec) {
    var base = rec.song && typeof rec.song === "object" ? rec.song : { id: rec.id, name: rec.name, duration: rec.duration || 0, artists: { primary: [{ name: rec.artist || "Unknown" }] } };
    var c = coverUrl(rec);
    var t = {}; for (var k in base) t[k] = base[k];
    t.id = rec.id;
    t.image = c ? [{ quality: "500x500", url: c, link: c }] : [];
    t.downloadUrl = [];
    t.__cxOff = true;
    return t;
  };
  dl.tracks = function () { return dl.all().then(function (a) { return a.map(dl.toTrack); }); };
  dl.track = function (id) { return dl.get(id).then(function (r) { return r ? dl.toTrack(r) : null; }); };
  dl.urlSync = function (id) { return audioUrls[String(id)] || ""; };
  dl.url = function (id) {
    id = String(id);
    if (audioUrls[id]) return Promise.resolve(audioUrls[id]);
    return dl.get(id).then(function (r) {
      if (!r || !r.audio) return "";
      audioUrls[id] = URL.createObjectURL(r.audio);
      return audioUrls[id];
    }).catch(function () { return ""; });
  };
  dl.remove = function (id) {
    id = String(id);
    return tx("readwrite", function (s) { return s.delete(id); }).then(function () {
      if (audioUrls[id]) { URL.revokeObjectURL(audioUrls[id]); delete audioUrls[id]; }
      if (coverUrls[id]) { URL.revokeObjectURL(coverUrls[id]); delete coverUrls[id]; }
      delete ids[id]; emit("downloads", { type: "remove", id: id });
    });
  };
  function streamUrl(song) {
    var d = song && song.downloadUrl; if (!d || !d.length) return "";
    var n = d[d.length - 1]; return (n && (n.link || n.url)) || "";
  }
  function imgUrl(song) {
    var d = song && song.image; if (!d || !d.length) return "";
    var n = d[d.length - 1]; return (n && (n.link || n.url)) || "";
  }
  var saving = {};
  // Saves one song for offline playback. Resolves true on success.
  dl.save = function (song, url) {
    if (!song || song.id == null) return Promise.resolve(false);
    var id = String(song.id);
    if (dl.has(id)) { toast("Already in Downloaded Songs"); return Promise.resolve(true); }
    if (saving[id]) return saving[id];
    url = url || streamUrl(song);
    if (!url) { toast("Download unavailable for this song", "error"); return Promise.resolve(false); }
    var name = song.name || "Song";
    toast("Downloading “" + name + "”…");
    var cover = imgUrl(song);
    saving[id] = Promise.all([
      fetch(url).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.blob(); }),
      cover ? fetch(cover).then(function (r) { return r.ok ? r.blob() : null; }).catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (b) {
      var clean = {}; for (var k in song) if (typeof song[k] !== "function") clean[k] = song[k];
      delete clean.__cxOff;
      var artist = (song.artists && song.artists.primary && song.artists.primary.map(function (a) { return a.name; }).join(", ")) || "Unknown";
      var rec = { id: id, song: clean, name: name, artist: artist, duration: song.duration || 0, audio: b[0], cover: b[1], size: b[0].size, savedAt: Date.now() };
      return tx("readwrite", function (s) { return s.put(rec); });
    }).then(function () {
      ids[id] = true; emit("downloads", { type: "add", id: id }); toast("Saved to Downloaded Songs"); return true;
    }).catch(function (e) {
      toast("Download failed. Check your connection and try again.", "error"); return false;
    }).then(function (ok) { delete saving[id]; return ok; });
    return saving[id];
  };
  dl.isSaving = function (id) { return !!saving[String(id)]; };

  // one-time move of downloads from the previous database name
  function migrateLegacy() {
    return new Promise(function (resolve) {
      try {
        if (localStorage.getItem("cxm_dl_migrated")) return resolve();
        var existed = true, r = indexedDB.open(LEGACY_DB);
        r.onupgradeneeded = function () { existed = false; try { r.transaction.abort(); } catch (e) {} };
        r.onerror = function () { resolve(); };
        r.onsuccess = function () {
          var d = r.result;
          if (!existed || !d.objectStoreNames.contains("songs")) { d.close(); try { indexedDB.deleteDatabase(LEGACY_DB); } catch (e) {} return resolve(); }
          var q = d.transaction("songs", "readonly").objectStore("songs").getAll();
          q.onsuccess = function () {
            var old = q.result || []; d.close();
            var chain = Promise.resolve();
            old.forEach(function (o) {
              chain = chain.then(function () {
                return tx("readwrite", function (s) { return s.put({ id: String(o.id), song: null, name: o.name, artist: o.artist, duration: o.duration || 0, audio: o.audio, cover: o.cover || null, size: o.audio ? o.audio.size : 0, savedAt: o.savedAt || Date.now() }); });
              });
            });
            chain.then(function () { try { indexedDB.deleteDatabase(LEGACY_DB); localStorage.setItem("cxm_dl_migrated", "1"); } catch (e) {} resolve(); }, function () { resolve(); });
          };
          q.onerror = function () { d.close(); resolve(); };
        };
      } catch (e) { resolve(); }
    });
  }
  migrateLegacy().then(refreshIds);

  /* ------------------------------------------------------------ install */
  var deferred = null;
  var install = (CX.install = {});
  function standalone() {
    try { return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; } catch (e) { return false; }
  }
  install.state = function () {
    var ua = navigator.userAgent || "";
    var ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    return { canPrompt: !!deferred, installed: standalone() || !!CX._installed, ios: ios, android: /android/i.test(ua), safari: /safari/i.test(ua) && !/chrome|crios|android/i.test(ua), firefox: /firefox|fxios/i.test(ua) };
  };
  // Resolves { outcome: "accepted" | "dismissed" | "unavailable" }
  install.prompt = function () {
    if (!deferred) return Promise.resolve({ outcome: "unavailable" });
    var d = deferred; deferred = null; emit("install", install.state());
    try { d.prompt(); } catch (e) { return Promise.resolve({ outcome: "unavailable" }); }
    return d.userChoice.then(function (c) { emit("install", install.state()); return c; });
  };
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; emit("install", install.state()); });
  window.addEventListener("appinstalled", function () { deferred = null; CX._installed = true; emit("install", install.state()); toast("Codexstudys Music installed"); });
  try { window.matchMedia("(display-mode: standalone)").addEventListener("change", function () { emit("install", install.state()); }); } catch (e) {}

  /* ---------------------------------------------------- service worker */
  CX.sw = null;
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(function (reg) { CX.sw = reg; try { reg.update(); } catch (e) {} }).catch(function () {});
    });
  }

  /* ----------------------------------------------------- Clear All Data */
  function deleteDb(name) {
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(); } }, 1800);
      try {
        var r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = function () { if (!done) { done = true; clearTimeout(t); resolve(); } };
      } catch (e) { clearTimeout(t); resolve(); }
    });
  }
  // The ONLY place that wipes persisted app data. Called after the user confirms.
  CX.clearAll = function () {
    window.__cxCleared = true;           // stops the player from re-saving state
    emit("clearing", {});
    try { if (window.__cxAudio) { window.__cxAudio.pause(); window.__cxAudio.removeAttribute("src"); window.__cxAudio.load(); } } catch (e) {}
    try { if ("mediaSession" in navigator) navigator.mediaSession.metadata = null; } catch (e) {}
    Object.keys(audioUrls).forEach(function (k) { try { URL.revokeObjectURL(audioUrls[k]); } catch (e) {} });
    Object.keys(coverUrls).forEach(function (k) { try { URL.revokeObjectURL(coverUrls[k]); } catch (e) {} });
    audioUrls = {}; coverUrls = {}; ids = {};
    var step = Promise.resolve();
    step = step.then(function () { try { localStorage.clear(); } catch (e) {} try { sessionStorage.clear(); } catch (e) {} });
    step = step.then(function () { return dbPromise ? dbPromise.then(function (d) { d.close(); }, function () {}) : null; }).then(function () { dbPromise = null; });
    step = step.then(function () {
      var names = [DB_NAME, LEGACY_DB];
      var p = indexedDB.databases ? indexedDB.databases().then(function (l) { (l || []).forEach(function (x) { if (x && x.name && names.indexOf(x.name) < 0) names.push(x.name); }); }, function () {}) : Promise.resolve();
      return p.then(function () { return Promise.all(names.map(deleteDb)); });
    });
    step = step.then(function () { return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : null; });
    step = step.then(function () {
      try { var c = navigator.serviceWorker && navigator.serviceWorker.controller; if (c) c.postMessage({ type: "cx-precache" }); } catch (e) {}
    });
    return step.catch(function () {}).then(function () { try { localStorage.clear(); } catch (e) {} });
  };

  /* --------------------------------------------- storage usage (settings) */
  CX.usage = function () {
    if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().then(function (e) { return e.usage || 0; }, function () { return 0; });
    return Promise.resolve(0);
  };
})();
