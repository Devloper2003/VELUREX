import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/channel-inventory/jobs?inventoryId= — push-queue rows for one grid
 * cell (used by the retry popover on failed cells).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const inventoryId = new URL(req.url).searchParams.get("inventoryId") ?? "";
  if (!inventoryId) return NextResponse.json({ error: "inventoryId is required" }, { status: 400 });

  const inv = await db.roomInventory.findFirst({
    where: { id: inventoryId, propertyId: auth.session.propertyId },
  });
  if (!inv) return NextResponse.json({ error: "Inventory row not found" }, { status: 404 });

  const jobs = await db.channelSyncJob.findMany({
    where: { roomInventoryId: inventoryId, status: { in: ["pending", "processing", "failed"] } },
    include: { connection: { select: { channel: true, status: true, isActive: true } } },
    orderBy: { createdAt: "desc" },
    take: 12,
  });

  return NextResponse.json({
    items: jobs.map((j) => ({
      id: j.id,
      channel: j.connection?.channel ?? "unknown",
      action: j.action,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
      createdAt: j.createdAt,
      channelActive: j.connection?.isActive ?? false,
    })),
  });
}
