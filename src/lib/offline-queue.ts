"use client";

import { getStoredToken } from "@/lib/store";

/**
 * Offline-first mutation queue backed by IndexedDB.
 * Used by housekeeping (and other offline-critical views): mutations made while
 * offline are queued locally and flushed automatically when connectivity returns.
 */

const DB_NAME = "velurex-offline";
const STORE = "queue";

function openDB(): Promise<IDBDatabase> {
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

export interface QueueItem {
  id?: number;
  clientRef: string;
  path: string;
  method: string;
  body: unknown;
  createdAt: number;
  label?: string;
}

export async function enqueue(op: Omit<QueueItem, "id" | "createdAt">): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ ...op, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Ask the service worker for a Background Sync round-trip: when connectivity
  // returns (even with the tab hidden), the 'sync' event replays the queue and
  // messages the result back to open views. Best-effort — page-level 'online'
  // flushing remains the primary path.
  try {
    if ("serviceWorker" in navigator && "sync" in (window.ServiceWorkerRegistration.prototype || {})) {
      const reg = await navigator.serviceWorker.ready;
      await (reg as unknown as { sync: { register: (tag: string) => Promise<void> } }).sync.register("velurex-flush");
    }
  } catch {
    /* BG sync unavailable — page flush handles it */
  }
}

export async function getQueue(): Promise<QueueItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueueItem[]);
    req.onerror = () => reject(req.error);
  });
}

export async function removeQueued(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearQueue(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Token for offline replay — in-memory store (cookie covers same-origin replay too). */
function token(): string | null {
  if (typeof window === "undefined") return null;
  return getStoredToken();
}

/**
 * Online-aware mutation executor:
 * tries the request; on network failure queues it for later replay.
 * Returns { queued: true } if stored offline, or the parsed response.
 */
export async function mutate<T = unknown>(
  path: string,
  method: string,
  body: unknown,
  label?: string
): Promise<{ queued: boolean; data?: T }> {
  const clientRef = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  // The queued body MUST carry the clientRef so a replayed mutation is
  // idempotent server-side (folio charges, payments, housekeeping tasks…).
  const bodyWithRef = { ...((body as object) || {}), clientRef };
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
      body: body !== undefined ? JSON.stringify(bodyWithRef) : undefined,
    });
    if (!res.ok && res.status >= 500) throw new Error("server error");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`);
    }
    return { queued: false, data: (await res.json()) as T };
  } catch (e) {
    // Network-level failure → queue for replay
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await enqueue({ clientRef, path, method, body: bodyWithRef, label });
      return { queued: true };
    }
    throw e;
  }
}

/** Flush the offline queue; returns number of successfully replayed ops. */
export async function flushQueue(): Promise<{ ok: number; failed: number }> {
  const items = await getQueue();
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const res = await fetch(item.path, {
        method: item.method,
        headers: { "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: JSON.stringify({ ...((item.body as object) || {}), clientRef: item.clientRef }),
      });
      // Replay is idempotent via clientRef, so any settled response (success OR
      // a definitive 4xx — e.g. the reservation moved on while we were offline)
      // resolves the item; only network/5xx failures stay queued.
      if (res.ok || (res.status < 500 && res.status >= 400)) {
        if (item.id !== undefined) await removeQueued(item.id);
        ok++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}

export async function cachedGet<T>(path: string, cacheKey: string): Promise<T | null> {
  try {
    const db = await openDB();
    // reuse the same DB with an extra store created lazily
    if (!db.objectStoreNames.contains("cache")) return null;
    return new Promise((resolve) => {
      const tx = db.transaction("cache", "readonly");
      const req = tx.objectStore("cache").get(cacheKey);
      req.onsuccess = () => resolve((req.result?.value as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePut(path: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains("cache")) {
      db.close();
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("cache")) {
            req.result.createObjectStore("cache");
          }
        };
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
    const db2 = await openDB();
    const tx = db2.transaction("cache", "readwrite");
    tx.objectStore("cache").put({ path, value }, key);
  } catch {
    /* best-effort cache */
  }
}
