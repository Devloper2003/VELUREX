/**
 * Server-side realtime emit helper (Next.js route handlers → mini-service).
 *
 * Fire-and-forget POST to the realtime mini-service (localhost:3003, /emit).
 * Never throws, never blocks the response: realtime push is best-effort —
 * if the mini-service is down the API response is unaffected and clients
 * fall back to their normal polling refresh.
 *
 * Usage inside route handlers:
 *   await emitRealtime("global", "activity:new", { title, details });
 *   emitRealtime("kitchen", "kot:update", { orderId, status }); // void, no await needed
 */

const RT_URL = "http://localhost:3003/emit";
const RT_SECRET = process.env.RT_SECRET ?? "velurex-rt-dev-secret";

export type RealtimeChannel = "global" | "kitchen" | (string & {});

export function emitRealtime(
  channel: RealtimeChannel,
  event: string,
  data: unknown,
): void {
  // Swallow all errors — realtime is best-effort by design.
  fetch(RT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: RT_SECRET, channel, event, data }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    /* mini-service unreachable — ignore */
  });
}
