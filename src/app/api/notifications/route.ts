import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const items = await db.activityLog.findMany({
    where: { propertyId: auth.session.propertyId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  return NextResponse.json({ items });
}
