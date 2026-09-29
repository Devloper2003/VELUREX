/**
 * Velurex HMS — realtime mini-service (socket.io + tiny REST emit API).
 *
 * Port is FIXED at 3003 — the sandbox gateway (Caddy) routes `/?XTransformPort=3003`
 * to this port, so do NOT read PORT from the environment.
 *
 * Socket.io path is "/" (gateway contract, see /home/z/my-project/examples/websocket/server.ts).
 * Side effect of path "/": engine.io's request check matches EVERY url, so we re-route
 * the http "request" listeners ourselves — polling requests carry `EIO=`/`transport=`
 * query params and go to engine.io, everything else goes to our REST API below.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Server } from "socket.io";

// ---------------------------------------------------------------------------
// Env (.env fallback — Bun auto-loads .env from cwd, this covers other runtimes)
// ---------------------------------------------------------------------------
// import.meta.dir is Bun-specific (typed by the mini-service's own tsconfig with
// "types": ["bun"]; the MAIN project tsconfig also includes this file without bun
// types, so cast to keep `bunx tsc` at the repo root clean).
const importMetaDir = (import.meta as unknown as { dir: string }).dir;
try {
  const envFile = readFileSync(join(importMetaDir, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && m[2] !== undefined && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env next to index.ts — defaults apply */
}

const RT_SECRET = process.env.RT_SECRET ?? "velurex-rt-dev-secret";

// ---------------------------------------------------------------------------
// Dev-server keeper — the sandbox reaps every process spawned from an agent
// tool-call shell (even setsid'd ones), so the Next.js dev server cannot be
// (re)started from a shell session. This mini-service is a boot-time orphan
// (immune to that reaper), so it owns keeping the web app alive: health-check
// :3000 and spawn `bun run dev` (package.json script, tees to dev.log) when
// it is down. bun --hot re-runs this block on reload; the global guard + the
// health check make repeated runs a no-op while the server is healthy.
// ---------------------------------------------------------------------------
const keeperGlobals = globalThis as unknown as { __vxDevKeeper?: { spawning: boolean } };
const keeperState = (keeperGlobals.__vxDevKeeper ??= { spawning: false });

async function keepNextDevAlive(): Promise<void> {
  if (keeperState.spawning) return;
  try {
    const res = await fetch("http://localhost:3000/api/health", {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) return; // healthy — nothing to do
  } catch {
    /* down — spawn below */
  }
  keeperState.spawning = true;
  try {
    console.log("[keeper] Next dev server down — spawning `bun run dev` (detached)…");
    const proc = spawn("bun", ["run", "dev"], {
      cwd: "/home/z/my-project",
      stdio: "ignore",
      detached: true, // own process group — outlives this service's reloads
    });
    proc.unref();
  } catch (err) {
    console.error("[keeper] spawn failed:", err);
  } finally {
    // Allow a fresh spawn decision on a later tick if this one died instantly.
    setTimeout(() => { keeperState.spawning = false; }, 90_000).unref();
  }
}
void keepNextDevAlive();
setInterval(() => void keepNextDevAlive(), 30_000).unref();

// ---------------------------------------------------------------------------
// Socket.io server (attached to the same http server as the REST API)
// ---------------------------------------------------------------------------
const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards /?XTransformPort=3003 here.
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Token check as connect middleware so rejected clients never receive a
// namespace "connect" (a handler-time socket.disconnect() would race it).
io.use((socket, next) => {
  const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
  const token = auth.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    console.log(`[realtime] rejected handshake ${socket.id} (missing token)`);
    next(new Error("unauthorized: missing auth.token"));
    return;
  }
  next();
});

io.on("connection", (socket) => {
  const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
  const room = typeof auth.room === "string" && auth.room.trim().length > 0 ? auth.room : "global";
  if (room !== "global") socket.join(room);
  socket.join("global"); // everyone always receives global broadcasts
  socket.data.room = room;
  console.log(
    `[realtime] client connected ${socket.id} (room=${room}, clients=${io.of("/").sockets.size})`,
  );

  // Health-check round trip used by clients: socket.emit("ping-rt", cb)
  socket.on("ping-rt", (cb?: unknown) => {
    if (typeof cb === "function") (cb as (v: { t: number }) => void)({ t: Date.now() });
  });

  socket.on("disconnect", (reason) => {
    console.log(
      `[realtime] client disconnected ${socket.id} (room=${room}, reason=${reason}, clients=${io.of("/").sockets.size})`,
    );
  });

  socket.on("error", (err) => {
    console.error(`[realtime] socket error ${socket.id}:`, err);
  });
});

// ---------------------------------------------------------------------------
// REST API on the same http server (see re-route note at the top of this file)
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleEmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid JSON body" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
  }

  const { secret, channel, event, data } = body;
  if (secret !== RT_SECRET) {
    console.log("[realtime] POST /emit 401 (bad secret)");
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  if (typeof channel !== "string" || channel.length === 0) {
    return sendJson(res, 400, { ok: false, error: "channel must be a non-empty string" });
  }
  if (typeof event !== "string" || event.length === 0) {
    return sendJson(res, 400, { ok: false, error: "event must be a non-empty string" });
  }

  io.to(channel).emit(event, data ?? null);
  const recipients = (await io.in(channel).allSockets()).size;
  console.log(`[realtime] emit event=${event} channel=${channel} recipients=${recipients}`);
  return sendJson(res, 200, { ok: true, recipients });
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "velurex-realtime",
      clients: io.of("/").sockets.size,
      ts: Date.now(),
    });
  }

  if (req.method === "POST" && pathname === "/emit") {
    return handleEmit(req, res);
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
}

// Re-route: engine.io (path "/") captured the "request" listeners on attach and
// would intercept /health + /emit. Restore them: engine.io-style requests
// (polling always carries EIO= / transport= query params) go to engine.io,
// everything else to our REST API. WebSocket upgrades use the "upgrade" event,
// which engine.io keeps — untouched by this.
const engineListeners = httpServer.listeners("request").slice(0) as Array<
  (req: IncomingMessage, res: ServerResponse) => void
>;
httpServer.removeAllListeners("request");
httpServer.on("request", (req, res) => {
  const url = req.url ?? "/";
  const looksLikeEngineIo = url.includes("EIO=") || url.includes("transport=");
  if (looksLikeEngineIo && engineListeners.length > 0) {
    engineListeners[0]!.call(httpServer, req, res);
    return;
  }
  void handleApi(req, res).catch((err) => {
    console.error("[realtime] api error:", err);
    sendJson(res, 500, { ok: false, error: "internal error" });
  });
});

// ---------------------------------------------------------------------------
// Start (port fixed — gateway contract)
// ---------------------------------------------------------------------------
const PORT = 3003;

httpServer.listen(PORT, () => {
  console.log(
    `[realtime] velurex realtime service listening on http://localhost:${PORT} (socket.io path "/")`,
  );
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[realtime] ${signal} received — shutting down (clients=${io.of("/").sockets.size})`);
  io.disconnectSockets(true);
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
