import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/channels/[id]/mappings — current room-type → OTA room-type mapping
 * plus the channel's catalog (its own room-type ids as shown in its extranet).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const conn = await db.channelConnection.findFirst({
    where: { id, propertyId },
    include: { mappings: true },
  });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });

  const roomTypes = await db.roomType.findMany({
    where: { propertyId },
    orderBy: { baseRate: "asc" },
    select: { id: true, name: true, code: true },
  });

  return NextResponse.json({
    mapping: conn.mappings.map((m) => ({ roomTypeId: m.roomTypeId, externalRoomTypeId: m.externalRoomTypeId })),
    roomTypes,
  });
}

/**
 * PUT /api/channels/[id]/mappings — replace the whole mapping set.
 * Body: { mappings: [{ roomTypeId, externalRoomTypeId }] } ("" = unmapped).
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const conn = await db.channelConnection.findFirst({ where: { id, propertyId } });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | { mappings?: { roomTypeId: string; externalRoomTypeId: string }[] }
    | null;
  if (!body?.mappings || !Array.isArray(body.mappings)) {
    return NextResponse.json({ error: "mappings[] is required" }, { status: 400 });
  }

  // Validate every roomTypeId belongs to this property
  const roomTypes = await db.roomType.findMany({ where: { propertyId }, select: { id: true } });
  const valid = new Set(roomTypes.map((r) => r.id));

  await db.$transaction(async (tx) => {
    await tx.channelRoomMapping.deleteMany({ where: { channelConnectionId: conn.id } });
    const rows = body.mappings!.filter((m) => valid.has(m.roomTypeId) && m.externalRoomTypeId);
    if (rows.length > 0) {
      await tx.channelRoomMapping.createMany({
        data: rows.map((m) => ({
          channelConnectionId: conn.id,
          roomTypeId: m.roomTypeId,
          externalRoomTypeId: m.externalRoomTypeId.trim(),
        })),
      });
    }
  });

  const mappedCount = body.mappings.filter((m) => m.externalRoomTypeId).length;
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_MAPPING",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: `Mapped ${mappedCount} room type${mappedCount === 1 ? "" : "s"} → ${conn.channel.replace("_", " ")} external ids`,
  });

  return NextResponse.json({ ok: true, mapped: mappedCount });
}
