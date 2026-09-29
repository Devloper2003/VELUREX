"use client";

import { useEffect } from "react";
import { getStoredToken } from "@/lib/store";

/**
 * Registers the Velurex service worker for offline-first PWA support and
 * wires the app-side half of the background-sync handshake:
 *  - replies to the SW's `velurex-get-token` request with the session token
 *    (localStorage lives on the page; the SW can't read it directly), so the
 *    background replay can authenticate its fetches;
 *  - forwards `velurex-sync-done` results onto the window as a DOM event so
 *    mounted views (billing, housekeeping, kitchen) can toast + refresh.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* SW registration is best-effort */
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad);

    // Answer the SW's token request (MessageChannel reply)
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (!event.ports?.length) return;
      if (data?.type === "velurex-get-token") {
        try {
          event.ports[0].postMessage({ token: getStoredToken() });
        } catch {
          event.ports[0].postMessage({ token: null });
        }
        return;
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    // Surface SW sync results to views
    const onSWMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; ok?: number; failed?: number } | null;
      if (data?.type === "velurex-sync-done") {
        window.dispatchEvent(new CustomEvent("velurex:sw-sync-done", { detail: { ok: data.ok ?? 0, failed: data.failed ?? 0 } }));
      }
    };
    navigator.serviceWorker.addEventListener("message", onSWMessage);

    return () => {
      window.removeEventListener("load", onLoad);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      navigator.serviceWorker.removeEventListener("message", onSWMessage);
    };
  }, []);
  return null;
}
