import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/** GET /api/settings/activity?limit=50 — recent activity log (audit trail). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const raw = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;

  const activities = await db.activityLog.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ activities, limit });
}
