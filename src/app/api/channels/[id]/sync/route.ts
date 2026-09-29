import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { enqueueChannelJobs } from "@/lib/channel-worker";
import { logActivity } from "@/lib/business";

type Params = { params: Promise<{ id: string }> };

const SYNC_WINDOW_DAYS = 30;

/**
 * POST /api/channels/[id]/sync — manual "Sync Now": pushes the current
 * inventory + rate state for the next 30 days × every mapped room type to
 * this channel (as `full_sync` jobs on the async queue).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const conn = await db.channelConnection.findFirst({
    where: { id, propertyId },
    include: { mappings: true },
  });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });
  if (conn.status !== "connected") {
    return NextResponse.json({ error: `Channel is ${conn.status} — reconnect it before syncing.` }, { status: 409 });
  }
  if (!conn.isActive) {
    return NextResponse.json({ error: "Channel is paused — resume pushing to sync." }, { status: 409 });
  }

  const mappings = conn.mappings.filter((m) => m.externalRoomTypeId);
  if (mappings.length === 0) {
    return NextResponse.json({ error: "No room types mapped — map room types first." }, { status: 409 });
  }

  const today = new Date();
  const dateList: string[] = [];
  for (let i = 0; i < SYNC_WINDOW_DAYS; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    dateList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  const rows = await db.roomInventory.findMany({
    where: { propertyId, roomTypeId: { in: mappings.map((m) => m.roomTypeId) }, date: { in: dateList } },
  });

  let queued = 0;
  for (const inv of rows) {
    queued += await enqueueChannelJobs({
      propertyId,
      inventoryId: inv.id,
      action: "full_sync",
      payload: {
        dateISO: inv.date,
        roomTypeId: inv.roomTypeId,
        availableCount: inv.availableCount,
        isOpen: inv.isOpen,
        rate: inv.rate,
      },
    });
  }

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_SYNC",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: `Manual full sync → ${conn.channel.replace("_", " ")}: ${rows.length} room-type-days × ${mappings.length} mapping(s) queued (${queued} pushes)`,
  });

  return NextResponse.json({
    ok: true,
    queued,
    roomTypeDays: rows.length,
    message: `Queued ${queued} pushes (${rows.length} room-type-days) to ${conn.channel.replace("_", " ")}.`,
  });
}
