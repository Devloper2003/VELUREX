import { subscribeEvent } from "@/lib/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/realtime/stream — Server-Sent Events endpoint (in-app realtime).
 *
 * Auth: the proxy (src/proxy.ts) already requires a valid session for this
 * path — JWT from the HttpOnly `velurex_session` cookie or the Authorization
 * header. EventSource always sends cookies, so logged-in browsers connect
 * transparently; anonymous requests get 401 from the proxy before we run.
 *
 * Channels: ?channel=global (default) | kitchen | <any non-empty string,
 * capped at 64 chars>.
 *
 * Wire format:
 *   event: hello   data: { t, channel }            → initial handshake
 *   event: rt      data: { event, data, ts }        → every published event
 *   `: hb <ts>`    comment heartbeat every 25s      → keeps proxies warm
 *
 * EventSource on the client reconnects automatically if the stream drops.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") ?? "global").trim().slice(0, 64) || "global";

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send(`event: hello\ndata: ${JSON.stringify({ t: Date.now(), channel })}\n\n`);

      unsub = subscribeEvent(channel, (event, data) => {
        send(`event: rt\ndata: ${JSON.stringify({ event, data, ts: Date.now() })}\n\n`);
      });

      heartbeat = setInterval(() => send(`: hb ${Date.now()}\n\n`), 25_000);

      req.signal.addEventListener("abort", finish);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx-style proxies: never buffer an event stream
      "X-Accel-Buffering": "no",
    },
  });
}
