import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

type RouteCtx = { params: Promise<{ id: string }> };

/** GET /api/guests/[id] — profile with stay history. */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const guest = await db.guest.findFirst({ where: { id, propertyId } });
  if (!guest) return NextResponse.json({ error: "Guest not found" }, { status: 404 });

  const reservations = await db.reservation.findMany({
    where: { propertyId, guestId: id },
    include: {
      room: { include: { roomType: { select: { name: true, code: true } } } },
      roomType: { select: { name: true, code: true } },
    },
    orderBy: { checkIn: "desc" },
  });

  const stays = reservations.filter((r) => ["checked_in", "checked_out"].includes(r.status));

  return NextResponse.json({
    guest,
    history: reservations.map((r) => ({
      id: r.id,
      confirmationNumber: r.confirmationNumber,
      roomNumber: r.room?.number ?? "—",
      roomTypeName: r.room?.roomType?.name ?? r.roomType?.name ?? "—",
      status: r.status,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights: r.nights,
      totalAmount: r.totalAmount,
      source: r.source,
    })),
    stats: {
      totalStays: stays.length,
      lastStayAt: stays.reduce<Date | null>((latest, r) => (!latest || r.checkOut > latest ? r.checkOut : latest), null),
      lifetimeValue: stays.reduce((sum, r) => sum + r.totalAmount, 0),
    },
  });
}

/** PATCH /api/guests/[id] — update profile (hotel_admin, front_desk). */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const guest = await db.guest.findFirst({ where: { id, propertyId } });
  if (!guest) return NextResponse.json({ error: "Guest not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: Record<string, unknown> = {};
  const fields = ["fullName", "phone", "email", "idType", "idNumber", "address", "city", "nationality", "photoUrl", "notes"] as const;
  for (const f of fields) {
    if (body[f] !== undefined) data[f] = String(body[f] ?? "");
  }
  if (data.fullName === "") return NextResponse.json({ error: "Guest name cannot be empty" }, { status: 400 });
  if (data.phone === "") return NextResponse.json({ error: "Phone cannot be empty" }, { status: 400 });

  const updated = await db.guest.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GUEST_UPDATE",
    entity: "Guest",
    entityId: id,
    details: `Updated guest profile ${updated.fullName}`,
  });

  return NextResponse.json({ guest: updated });
}
