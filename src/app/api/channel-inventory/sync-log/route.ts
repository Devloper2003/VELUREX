import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/channel-inventory/sync-log?limit=100&channel=&status= — the
 * sync-log viewer feed: every push attempt (success/failed) with channel,
 * action, room type, date and message.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);
  const channel = url.searchParams.get("channel") ?? "";
  const status = url.searchParams.get("status") ?? "";

  const logs = await db.channelSyncLog.findMany({
    where: {
      propertyId,
      ...(channel ? { channel } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { attemptedAt: "desc" },
    take: limit,
    include: {
      inventory: { select: { date: true, roomType: { select: { name: true, code: true } } } },
    },
  });

  return NextResponse.json({
    items: logs.map((l) => ({
      id: l.id,
      channel: l.channel,
      action: l.action,
      status: l.status,
      message: l.message,
      attemptedAt: l.attemptedAt,
      date: l.inventory?.date ?? null,
      roomTypeName: l.inventory ? `${l.inventory.roomType.name}` : null,
    })),
  });
}
