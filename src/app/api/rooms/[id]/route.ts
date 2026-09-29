import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

const ROOM_STATUSES = ["vacant", "occupied", "dirty", "clean", "out_of_order"];
const ACTIVE_STATUSES = ["confirmed", "checked_in", "hold"];

type RouteCtx = { params: Promise<{ id: string }> };

/** PATCH /api/rooms/[id] — update room. housekeeping may only change status/note. */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const room = await db.room.findFirst({ where: { id, propertyId }, include: { roomType: true } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const isHousekeeping = auth.session.role === "housekeeping";

  // Housekeeping is restricted to housekeeping-relevant fields.
  const forbidden = isHousekeeping
    ? Object.keys(body).filter((k) => !["status", "note"].includes(k))
    : [];
  if (forbidden.length > 0)
    return NextResponse.json({ error: `Housekeeping staff may only update status and note (got: ${forbidden.join(", ")})` }, { status: 403 });

  const data: { number?: string; floor?: number; roomTypeId?: string; status?: string; note?: string } = {};

  if (body.number !== undefined) {
    const number = String(body.number).trim();
    if (!number) return NextResponse.json({ error: "Room number cannot be empty" }, { status: 400 });
    const dupe = await db.room.findFirst({ where: { propertyId, number, id: { not: id } } });
    if (dupe) return NextResponse.json({ error: `Room ${number} already exists on this property` }, { status: 409 });
    data.number = number;
  }
  if (body.floor !== undefined) {
    const floor = Number(body.floor);
    if (Number.isNaN(floor) || floor < 0) return NextResponse.json({ error: "Invalid floor" }, { status: 400 });
    data.floor = floor;
  }
  if (body.roomTypeId !== undefined) {
    const rt = await db.roomType.findFirst({ where: { id: String(body.roomTypeId), propertyId } });
    if (!rt) return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    data.roomTypeId = rt.id;
  }
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!ROOM_STATUSES.includes(status))
      return NextResponse.json({ error: `Status must be one of: ${ROOM_STATUSES.join(", ")}` }, { status: 400 });
    data.status = status;
  }
  if (body.note !== undefined) data.note = String(body.note ?? "");

  // Occupancy conflict validation when forcing a status.
  if (data.status !== undefined) {
    const inHouse = await db.reservation.findFirst({
      where: { roomId: id, propertyId, status: "checked_in" },
      include: { guest: { select: { fullName: true } } },
    });
    if (inHouse && data.status !== "occupied" && data.status !== "dirty") {
      return NextResponse.json(
        { error: `Room has an in-house guest (${inHouse.guest.fullName}) — check them out before marking it ${data.status.replace("_", " ")}` },
        { status: 409 }
      );
    }
    if (!inHouse && data.status === "occupied") {
      return NextResponse.json({ error: "Cannot mark a room occupied without an in-house guest — check in a reservation instead" }, { status: 409 });
    }
  }

  const updated = await db.room.update({ where: { id }, data, include: { roomType: true } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_UPDATE",
    entity: "Room",
    entityId: id,
    details: `Updated room ${updated.number}: ${Object.keys(data).join(", ") || "no changes"}`,
  });

  return NextResponse.json({ room: updated });
}

/** DELETE /api/rooms/[id] — hotel_admin only; blocked when active reservations exist. */
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const room = await db.room.findFirst({ where: { id, propertyId } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const active = await db.reservation.findFirst({
    where: { roomId: id, propertyId, status: { in: ACTIVE_STATUSES } },
  });
  if (active)
    return NextResponse.json(
      { error: `Cannot delete room ${room.number} — it has active reservations (e.g. ${active.confirmationNumber})` },
      { status: 409 }
    );

  // Detach historical reservations so the room record can be removed cleanly.
  await db.reservation.updateMany({ where: { roomId: id }, data: { roomId: null } });
  await db.room.delete({ where: { id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_DELETE",
    entity: "Room",
    entityId: id,
    details: `Deleted room ${room.number} (floor ${room.floor})`,
  });

  return NextResponse.json({ ok: true });
}
