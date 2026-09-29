import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { runDailyJobs } from "@/lib/platform-jobs";

/**
 * POST /api/owner/cron/daily — manual trigger for the daily platform jobs
 * (also invoked hourly by the in-process scheduler when the day rolls over).
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const result = await runDailyJobs();
  return NextResponse.json({ ok: true, ...result });
}
