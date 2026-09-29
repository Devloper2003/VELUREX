import { NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/booking-guard";

/**
 * POST /api/booking-engine/holds/sweep — public TTL sweeper. Reclaims
 * inventory from abandoned checkouts (active holds past their expiry).
 * Called by the /book checkout countdown and the channel-worker tick so
 * expired holds are reaped even when no guest is watching.
 */
export async function POST() {
  const released = await sweepExpiredHolds();
  return NextResponse.json({ ok: true, released });
}
