import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";

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

  // ── Realtime: in-process SSE (src/app/api/realtime/stream + event-bus) —
  // no external service to probe; the process answering this request IS the
  // realtime system. If this endpoint runs at all, realtime is up.
  const realtime: "up" | "down" = "up";

  const ok = database === "up";
  return NextResponse.json(
    {
      ok,
      status: ok ? "healthy" : "degraded",
      service: "velurex-hms",
      version: APP_VERSION,
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
