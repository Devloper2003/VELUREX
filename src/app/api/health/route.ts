import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — operational health probe (public per middleware allow-list).
 * Checks DB connectivity + the realtime mini-service and reports core KPIs so
 * uptime monitors can distinguish "app up" from "app fully functional".
 */
export async function GET() {
  const startedAt = Date.now();

  // ── DB check: cheapest possible round-trip + a couple of live counts
  let database: "up" | "down" = "down";
  let dbError: string | null = null;
  let businessDate: string | null = null;
  let counts: { rooms: number; inHouse: number; openFolios: number } | null = null;
  try {
    const [property, rooms, inHouse, folioGroups] = await Promise.all([
      db.property.findFirst({ select: { businessDate: true } }),
      db.room.count(),
      db.reservation.count({ where: { status: "checked_in" } }),
      db.folioItem.groupBy({ by: ["reservationId"] }),
    ]);
    database = "up";
    businessDate = property?.businessDate ? property.businessDate.toISOString().slice(0, 10) : null;
    counts = { rooms, inHouse, openFolios: folioGroups.length };
  } catch (e) {
    dbError = e instanceof Error ? e.message : "unknown error";
  }

  // ── Realtime mini-service probe (best-effort, never blocks the probe)
  let realtime: "up" | "down" = "down";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("http://localhost:3003/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res.ok) realtime = "up";
  } catch {
    /* realtime down is non-fatal — the app falls back to 45s polling */
  }

  const ok = database === "up";
  return NextResponse.json(
    {
      ok,
      status: ok ? "healthy" : "degraded",
      service: "velurex-hms",
      version: "1.0.0",
      uptimeSec: Math.round(process.uptime()),
      checks: { database, realtime },
      businessDate,
      counts,
      latencyMs: Date.now() - startedAt,
      ts: new Date().toISOString(),
      // Sanitized for a PUBLIC endpoint: never echo the raw driver error here
      // (it can disclose the database host). Real details live in function logs.
      ...(dbError ? { dbError: "unable to reach database" } : {}),
    },
    { status: ok ? 200 : 503 },
  );
}
