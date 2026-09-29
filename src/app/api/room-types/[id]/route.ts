import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

type RouteCtx = { params: Promise<{ id: string }> };

/** PATCH /api/room-types/[id] — update a room type (hotel_admin). */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const roomType = await db.roomType.findFirst({ where: { id, propertyId } });
  if (!roomType) return NextResponse.json({ error: "Room type not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    data.name = name;
  }
  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase();
    if (!code) return NextResponse.json({ error: "Code cannot be empty" }, { status: 400 });
    const dupe = await db.roomType.findFirst({ where: { propertyId, code, id: { not: id } } });
    if (dupe) return NextResponse.json({ error: `Room type code "${code}" already exists` }, { status: 409 });
    data.code = code;
  }
  if (body.baseRate !== undefined) {
    const baseRate = Number(body.baseRate);
    if (Number.isNaN(baseRate) || baseRate <= 0)
      return NextResponse.json({ error: "Base rate must be a positive number" }, { status: 400 });
    data.baseRate = baseRate;
  }
  if (body.maxOccupancy !== undefined) {
    const maxOccupancy = Number(body.maxOccupancy);
    if (Number.isNaN(maxOccupancy) || maxOccupancy < 1)
      return NextResponse.json({ error: "Max occupancy must be at least 1" }, { status: 400 });
    data.maxOccupancy = maxOccupancy;
  }
  if (body.sizeSqft !== undefined) data.sizeSqft = Number(body.sizeSqft) || 250;
  if (body.bedType !== undefined) data.bedType = String(body.bedType);
  if (body.description !== undefined) data.description = String(body.description);
  if (body.amenities !== undefined) {
    const amenities: string[] = Array.isArray(body.amenities)
      ? body.amenities.map((a: unknown) => String(a)).filter(Boolean)
      : String(body.amenities).split(",").map((a: string) => a.trim()).filter(Boolean);
    data.amenities = JSON.stringify(amenities);
  }

  const updated = await db.roomType.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_TYPE_UPDATE",
    entity: "RoomType",
    entityId: id,
    details: `Updated room type ${updated.name} (${updated.code})`,
  });

  return NextResponse.json({ roomType: { ...updated, amenities: JSON.parse(updated.amenities || "[]") } });
}

/** DELETE /api/room-types/[id] — delete a room type (hotel_admin); blocked when rooms exist. */
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const roomType = await db.roomType.findFirst({
    where: { id, propertyId },
    include: { _count: { select: { rooms: true, reservations: true, ratePlans: true } } },
  });
  if (!roomType) return NextResponse.json({ error: "Room type not found" }, { status: 404 });

  if (roomType._count.rooms > 0)
    return NextResponse.json(
      { error: `Cannot delete "${roomType.name}" — ${roomType._count.rooms} room(s) still use this type` },
      { status: 409 }
    );

  await db.roomType.delete({ where: { id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_TYPE_DELETE",
    entity: "RoomType",
    entityId: id,
    details: `Deleted room type ${roomType.name} (${roomType.code})`,
  });

  return NextResponse.json({ ok: true });
}
