/**
 * Server-side realtime emit helper (Next.js route handlers → in-process bus).
 *
 * Events are published on the in-process event bus (src/lib/event-bus.ts) and
 * fanned out to browsers by the SSE stream route (/api/realtime/stream).
 * Never throws, never blocks the response: realtime push is best-effort —
 * if no client is subscribed the event is simply dropped and UIs fall back
 * to their normal polling refresh.
 *
 * Usage inside route handlers:
 *   await emitRealtime("global", "activity:new", { title, details });
 *   emitRealtime("kitchen", "kot:update", { orderId, status }); // void, no await needed
 */

import { publishEvent } from "@/lib/event-bus";

export type RealtimeChannel = "global" | "kitchen" | (string & {});

export function emitRealtime(
  channel: RealtimeChannel,
  event: string,
  data: unknown,
): void {
  // Swallow all errors — realtime is best-effort by design.
  try {
    publishEvent(channel, event, data);
  } catch {
    /* event bus can never realistically throw; belt and braces */
  }
}
