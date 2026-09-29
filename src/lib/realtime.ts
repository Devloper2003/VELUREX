/**
 * Realtime client helper for the Velurex HMS UI.
 *
 * Talks to the realtime mini-service (mini-services/realtime-service): a socket.io
 * server fixed on port 3003 behind the sandbox gateway (Caddy). The gateway routes
 * on the `XTransformPort=3003` query param, so the connection URL MUST stay in the
 * relative form "/?XTransformPort=3003" with socket.io path "/" — never an absolute
 * URL or explicit port.
 *
 * Usage (client components):
 *   useRealtime((event, data) => { ... }, (status) => { ... });
 *   // or imperatively:
 *   const dispose = connectRealtime({ room: "kitchen", token, onEvent, onStatus });
 *
 * Events pushed by the service: "kot:update", "activity:new", "night-audit:done",
 * "folio:update". Server-side code pushes into rooms via POST /emit on :3003.
 */

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useSession } from "@/lib/store";

export type RealtimeStatus = "connecting" | "online" | "offline";

export type RealtimeEvent = { event: string; data: unknown; ts: number };

/** Events the mini-service pushes to rooms (see mini-services/realtime-service/index.ts). */
const REALTIME_EVENTS = ["kot:update", "activity:new", "night-audit:done", "folio:update"] as const;

const DEFAULT_ROOM = "global";

type EventListener = (event: string, data: unknown) => void;
type StatusListener = (status: RealtimeStatus) => void;

type RoomEntry = {
  socket: Socket;
  listeners: Set<EventListener>;
  statusCbs: Set<StatusListener>;
};

/** One socket per room, shared by every mounted component on that room (ref-counted). */
const rooms = new Map<string, RoomEntry>();

function getOrCreateRoom(room: string, token: string | null): RoomEntry {
  const existing = rooms.get(room);
  if (existing) return existing;

  const socket = io("/?XTransformPort=3003", {
    path: "/",
    auth: { token: token ?? "anon", room },
    transports: ["websocket", "polling"],
    tryAllTransports: true, // if the websocket handshake fails, fall back to polling
    reconnection: true,
    reconnectionDelay: 2000,
    multiplex: false, // each room carries its own auth payload → its own connection
  });

  const entry: RoomEntry = { socket, listeners: new Set(), statusCbs: new Set() };
  rooms.set(room, entry);

  const emitStatus = (status: RealtimeStatus) => {
    for (const cb of entry.statusCbs) cb(status);
  };
  socket.on("connect", () => emitStatus("online"));
  socket.on("disconnect", () => emitStatus("offline"));
  socket.on("connect_error", () => emitStatus("offline"));
  socket.io.on("reconnect_attempt", () => emitStatus("connecting"));

  for (const evt of REALTIME_EVENTS) {
    socket.on(evt, (data) => {
      for (const cb of entry.listeners) cb(evt, data);
    });
  }
  return entry;
}

export function connectRealtime(opts: {
  room?: string;
  token: string | null;
  onEvent: (event: string, data: unknown) => void;
  onStatus?: (status: RealtimeStatus) => void;
}): () => void {
  if (typeof window === "undefined") return () => {}; // SSR guard

  const room = opts.room ?? DEFAULT_ROOM;
  const entry = getOrCreateRoom(room, opts.token);
  entry.listeners.add(opts.onEvent);
  if (opts.onStatus) {
    entry.statusCbs.add(opts.onStatus);
    // Report the current state immediately so late subscribers aren't blind
    // until the next connect/disconnect transition.
    opts.onStatus(entry.socket.connected ? "online" : "connecting");
  }

  return () => {
    entry.listeners.delete(opts.onEvent);
    if (opts.onStatus) entry.statusCbs.delete(opts.onStatus);
    // Ref-count: only tear the socket down when the last listener is removed.
    if (entry.listeners.size === 0 && entry.statusCbs.size === 0) {
      rooms.delete(room);
      entry.socket.removeAllListeners();
      entry.socket.io.removeAllListeners();
      entry.socket.disconnect();
    }
  };
}

/**
 * Round-trip health check against the mini-service via the shared socket's
 * "ping-rt" event. Resolves the server timestamp, or null when the shared
 * socket for the room isn't connected / doesn't ack in time.
 */
export function pingRealtime(room?: string): Promise<number | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const entry = rooms.get(room ?? DEFAULT_ROOM);
  if (!entry || !entry.socket.connected) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => done(null), 5000);
    entry.socket.emit("ping-rt", (res: unknown) => {
      clearTimeout(timer);
      const t = (res as { t?: number } | null)?.t;
      done(typeof t === "number" ? t : null);
    });
  });
}

/**
 * React hook: subscribes the calling component to realtime events for the
 * "global" room using the session token from the zustand store. Callbacks are
 * kept in refs, so the socket is NOT reconnected when the callbacks change —
 * the effect only re-runs if the token itself changes. Cleanup on unmount.
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
