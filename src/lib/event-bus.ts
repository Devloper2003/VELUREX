/**
 * In-process realtime event bus (server-side pub/sub).
 *
 * Replaces the external socket.io mini-service as the event backbone: route
 * handlers publish here (see emitRealtime in src/lib/realtime-server.ts) and
 * the SSE stream route (/api/realtime/stream) subscribes on behalf of each
 * connected browser. Single-process deployment — no extra port, no gateway.
 *
 * Stored on globalThis so dev-server HMR/module reloads reuse the same bus
 * instead of silently forking a second one.
 */

export type BusListener = (event: string, data: unknown) => void;

type Bus = Map<string, Set<BusListener>>;

const g = globalThis as unknown as { __vlxEventBus?: Bus };
const bus: Bus = (g.__vlxEventBus ??= new Map());

/** Publish an event to every subscriber of the channel. Never throws. */
export function publishEvent(channel: string, event: string, data: unknown): void {
  const subs = bus.get(channel);
  if (!subs || subs.size === 0) return;
  for (const fn of subs) {
    try {
      fn(event, data);
    } catch {
      /* a broken subscriber must never break the publisher */
    }
  }
}

/** Subscribe to a channel. Returns an unsubscribe function. */
export function subscribeEvent(channel: string, fn: BusListener): () => void {
  let subs = bus.get(channel);
  if (!subs) {
    subs = new Set();
    bus.set(channel, subs);
  }
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (subs.size === 0) bus.delete(channel);
  };
}

/** Diagnostics: current subscriber counts per channel. */
export function busStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ch, subs] of bus) out[ch] = subs.size;
  return out;
}
