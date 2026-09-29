/* Velurex HMS — offline-first service worker */
const CACHE = "velurex-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ── Background sync: replay the offline mutation queue ──────────────────
   When connectivity returns (even with the tab hidden or closed), the
   browser fires the 'sync' event for our tag. We replay the IndexedDB
   queue the same way the page does: idempotent via clientRef, and any
   settled response (2xx or definitive 4xx) resolves the item. After the
   run we message every client so open views can toast + refresh.        */
const DB_NAME = "velurex-offline";
const STORE = "queue";

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function queueItems(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function deleteQueued(db, id) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function replayQueue() {
  let db;
  let items;
  try {
    db = await openQueueDB();
    items = await queueItems(db);
  } catch {
    return { ok: 0, failed: 0 };
  }
  if (!items.length) return { ok: 0, failed: 0 };

  // Ask an open client for the auth token (page localStorage) via MessageChannel.
  const token = await new Promise((resolve) => {
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        if (!clientsArr.length) return resolve(null);
        const mc = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 3000);
        mc.port1.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(ev.data?.token || null);
        };
        clientsArr[0].postMessage({ type: "velurex-get-token" }, [mc.port2]);
      })
      .catch(() => resolve(null));
  });

  let ok = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const res = await fetch(item.path, {
        method: item.method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...((item.body || {}) || {}), clientRef: item.clientRef }),
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (item.id !== undefined) await deleteQueued(db, item.id);
        ok++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  // If everything resolved, drop the (now empty) connection; notify open views.
  const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clientsArr) c.postMessage({ type: "velurex-sync-done", ok, failed });
  return { ok, failed };
}

self.addEventListener("sync", (event) => {
  if (event.tag === "velurex-flush") {
    event.waitUntil(replayQueue());
  }
});

// Fallback: some browsers don't support Background Sync — the page can trigger
// the replay directly (e.g. on its 'online' listener) via postMessage.
self.addEventListener("message", (event) => {
  if (event.data?.type === "velurex-trigger-flush") {
    event.waitUntil(replayQueue());
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API reads: network-first, fall back to cached response when offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ||
              new Response(JSON.stringify({ error: "You are offline — showing cached data is unavailable for this request." }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
              })
          )
        )
    );
    return;
  }

  // Static assets / pages: cache-first with background refresh.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached || caches.match("/"));
      return cached || network;
    })
  );
});
