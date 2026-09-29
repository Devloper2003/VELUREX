import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { processChannelJobs } from "@/lib/channel-worker";
import { sweepExpiredHolds } from "@/lib/booking-guard";

/**
 * POST /api/channels/worker — queue tick. Drains up to 12 pending push jobs
 * for the caller's property and reaps expired booking holds (the race-guard
 * TTL sweeper) in the same beat. The Inventory Control view calls this on a
 * short poll while open (and once right after any toggle), which keeps the
 * async queue moving without an external cron/Redis dependency.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const result = await processChannelJobs(auth.session.propertyId);
  const expiredHolds = await sweepExpiredHolds(auth.session.propertyId);
  return NextResponse.json({ ...result, expiredHolds });
}
