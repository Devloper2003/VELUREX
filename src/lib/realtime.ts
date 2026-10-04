/**
 * Realtime client helper for the Velurex HMS UI.
 *
 * Transport: Server-Sent Events over same-origin /api/realtime/stream — no
 * extra port, no gateway query tricks, works on every host the app itself
 * works on (including the live deployment). The server pushes a named SSE
 * event "rt" carrying { event, data, ts }; the connection is authenticated by
 * the HttpOnly session cookie (EventSource cannot set Authorization headers).
 *
 * Usage (client components):
 *   useRealtime((event, data) => { ... }, (status) => { ... });
 *   // or imperatively:
 *   const dispose = connectRealtime({ room: "kitchen", token, onEvent, onStatus });
 *
 * Events pushed by the server: "kot:update", "activity:new", "night-audit:done",
 * "folio:update" (published via emitRealtime → src/lib/event-bus.ts).
 */

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/store";

export type RealtimeStatus = "connecting" | "online" | "offline";

export type RealtimeEvent = { event: string; data: unknown; ts: number };

/** Events the server pushes (see src/lib/realtime-server.ts emit sites). */
const REALTIME_EVENTS = ["kot:update", "activity:new", "night-audit:done", "folio:update"] as const;

const DEFAULT_ROOM = "global";

type EventListener = (event: string, data: unknown) => void;
type StatusListener = (status: RealtimeStatus) => void;

type RoomEntry = {
  es: EventSource;
  listeners: Set<EventListener>;
  statusCbs: Set<StatusListener>;
  status: RealtimeStatus;
};

/** One stream per room, shared by every mounted component on that room (ref-counted). */
const rooms = new Map<string, RoomEntry>();

function streamUrl(room: string): string {
  return `/api/realtime/stream?channel=${encodeURIComponent(room)}`;
}

function getOrCreateRoom(room: string): RoomEntry {
  const existing = rooms.get(room);
  if (existing) return existing;

  const es = new EventSource(streamUrl(room));

  const entry: RoomEntry = { es, listeners: new Set(), statusCbs: new Set(), status: "connecting" };
  rooms.set(room, entry);

  const emitStatus = (status: RealtimeStatus) => {
    entry.status = status;
    for (const cb of entry.statusCbs) cb(status);
  };

  es.addEventListener("hello", () => emitStatus("online"));
  es.onopen = () => emitStatus("online");
  es.onerror = () => {
    // EventSource retries automatically; report where we are in that cycle.
    emitStatus(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
  };

  es.addEventListener("rt", (e) => {
    let parsed: RealtimeEvent | null = null;
    try {
      parsed = JSON.parse((e as MessageEvent).data) as RealtimeEvent;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.event !== "string") return;
    if (!(REALTIME_EVENTS as readonly string[]).includes(parsed.event)) return;
    for (const cb of entry.listeners) cb(parsed.event, parsed.data);
  });

  return entry;
}

export function connectRealtime(opts: {
  room?: string;
  /** Kept for API compatibility; the stream authenticates via the session cookie. */
  token?: string | null;
  onEvent: (event: string, data: unknown) => void;
  onStatus?: (status: RealtimeStatus) => void;
}): () => void {
  if (typeof window === "undefined") return () => {}; // SSR guard
  if (typeof EventSource === "undefined") {
    // Very old browsers — the app's polling refresh covers everything.
    opts.onStatus?.("offline");
    return () => {};
  }

  const room = opts.room ?? DEFAULT_ROOM;
  const entry = getOrCreateRoom(room);
  entry.listeners.add(opts.onEvent);
  if (opts.onStatus) {
    entry.statusCbs.add(opts.onStatus);
    // Report the current state immediately so late subscribers aren't blind
    // until the next open/error transition.
    opts.onStatus(entry.status);
  }

  return () => {
    entry.listeners.delete(opts.onEvent);
    if (opts.onStatus) entry.statusCbs.delete(opts.onStatus);
    // Ref-count: only tear the stream down when the last listener is removed.
    if (entry.listeners.size === 0 && entry.statusCbs.size === 0) {
      rooms.delete(room);
      entry.es.close();
    }
  };
}

/**
 * Round-trip probe against the same-origin realtime ping endpoint.
 * Resolves the server timestamp, or null when the request fails.
 */
export async function pingRealtime(_room?: string): Promise<number | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/realtime/ping", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { t?: number };
    return typeof j.t === "number" ? j.t : null;
  } catch {
    return null;
  }
}

/**
 * React hook: subscribes the calling component to realtime events for the
 * "global" room. Callbacks are kept in refs, so the stream is NOT reopened
 * when the callbacks change — the effect only re-runs if the token changes.
 * Cleanup on unmount.
 */
export function useRealtime(
  onEvent: (event: string, data: unknown) => void,
  onStatus?: (status: RealtimeStatus) => void,
): void {
  const token = useSession((s) => s.token);
  const onEventRef = useRef(onEvent);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onEventRef.current = onEvent;
    onStatusRef.current = onStatus;
  });

  useEffect(() => {
    return connectRealtime({
      token,
      onEvent: (event, data) => onEventRef.current(event, data),
      onStatus: (status) => onStatusRef.current?.(status),
    });
  }, [token]);
}
