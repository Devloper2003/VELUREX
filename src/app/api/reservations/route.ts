import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";
import { validatePromo } from "@/app/api/booking-engine/_shared";
import { getTenantEntitlements, assertWritable } from "@/lib/entitlements";

const BLOCKING_STATUSES = ["confirmed", "checked_in", "hold"];
const RES_STATUSES = ["hold", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"];
const SOURCES = ["front_desk", "booking_engine", "walk_in", "ota", "phone"];

async function uniqueConfirmationNumber(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = `RG-${Date.now().toString().slice(-8)}${i > 0 ? `-${i}` : ""}`;
    const exists = await db.reservation.findUnique({ where: { confirmationNumber: candidate } });
    if (!exists) return candidate;
  }
  return `RG-${Date.now().toString(36).toUpperCase()}`;
}

/** GET /api/reservations — filters: status (csv), search (guest/confirmation), from/to (checkIn range), limit. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const search = searchParams.get("search")?.trim();
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limitParam = Number(searchParams.get("limit"));

  const where: Record<string, unknown> = { propertyId };

  if (statusParam) {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter((s) => RES_STATUSES.includes(s));
    if (statuses.length > 0) where.status = { in: statuses };
  }
  if (from || to) {
    where.checkIn = {
      ...(from && !Number.isNaN(new Date(from).getTime()) ? { gte: new Date(from) } : {}),
      ...(to && !Number.isNaN(new Date(`${to}T23:59:59`).getTime()) ? { lte: new Date(`${to}T23:59:59`) } : {}),
    };
  }
  if (search) {
    where.OR = [
      { confirmationNumber: { contains: search, mode: "insensitive" } },
      { guest: { is: { fullName: { contains: search, mode: "insensitive" } } } },
      { guest: { is: { phone: { contains: search, mode: "insensitive" } } } },
    ];
  }

  const reservations = await db.reservation.findMany({
    where,
    include: {
      guest: { select: { id: true, fullName: true, phone: true, email: true, photoUrl: true } },
      room: { include: { roomType: { select: { id: true, name: true, code: true } } } },
      roomType: { select: { id: true, name: true, code: true, baseRate: true } },
    },
    orderBy: { createdAt: "desc" },
    take: Number.isNaN(limitParam) || limitParam <= 0 ? undefined : Math.min(limitParam, 500),
  });

  return NextResponse.json({ reservations });
}

/** POST /api/reservations — create a reservation (hotel_admin, front_desk). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: read-only when suspended / overdue past grace.
  const ent = await getTenantEntitlements(propertyId);
  const ro = assertWritable(ent);
  if (ro) return ro;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const checkIn = new Date(body.checkIn);
  const checkOut = new Date(body.checkOut);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()))
    return NextResponse.json({ error: "Valid checkIn and checkOut dates are required" }, { status: 400 });

  const startIn = new Date(checkIn.getFullYear(), checkIn.getMonth(), checkIn.getDate());
  const startOut = new Date(checkOut.getFullYear(), checkOut.getMonth(), checkOut.getDate());
  if (startOut <= startIn)
    return NextResponse.json({ error: "Check-out date must be after check-in date" }, { status: 400 });

  const nights = Math.round((startOut.getTime() - startIn.getTime()) / 86400000);
  const adults = Math.max(1, Number(body.adults ?? 1) || 1);
  const children = Math.max(0, Number(body.children ?? 0) || 0);
  const status = body.status ? String(body.status) : "confirmed";
  // "waitlist" (and any unknown value) maps to hold for new bookings.
  const finalStatus = ["hold", "waitlist"].includes(status) ? "hold" : RES_STATUSES.includes(status) ? status : "confirmed";
  const source = SOURCES.includes(body.source) ? body.source : "front_desk";
  const nightlyRate = Number(body.nightlyRate);
  if (Number.isNaN(nightlyRate) || nightlyRate <= 0)
    return NextResponse.json({ error: "A positive nightly rate is required" }, { status: 400 });

  // Resolve guest — inline creation or existing reference.
  let guestId: string = body.guestId ? String(body.guestId) : "";
  if (body.guest && typeof body.guest === "object") {
    const g = body.guest;
    const fullName = String(g.fullName ?? "").trim();
    const phone = String(g.phone ?? "").trim();
    if (!fullName || !phone)
      return NextResponse.json({ error: "Guest name and phone are required" }, { status: 400 });
    const guest = await db.guest.create({
      data: {
        propertyId,
        fullName,
        phone,
        email: String(g.email ?? ""),
        idType: String(g.idType ?? ""),
        idNumber: String(g.idNumber ?? ""),
        city: String(g.city ?? ""),
        address: String(g.address ?? ""),
      },
    });
    guestId = guest.id;
  }
  if (!guestId) return NextResponse.json({ error: "A guestId or inline guest details are required" }, { status: 400 });
  const guest = await db.guest.findFirst({ where: { id: guestId, propertyId } });
  if (!guest) return NextResponse.json({ error: "Guest not found" }, { status: 404 });

  // Resolve room + room type and run the availability check.
  let roomId: string | null = body.roomId ? String(body.roomId) : null;
  let roomTypeId: string | null = body.roomTypeId ? String(body.roomTypeId) : null;

  if (roomId) {
    const room = await db.room.findFirst({ where: { id: roomId, propertyId }, include: { roomType: true } });
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (room.status === "out_of_order")
      return NextResponse.json({ error: `Room ${room.number} is out of order` }, { status: 409 });
    roomTypeId = room.roomTypeId;

    const overlap = await db.reservation.findFirst({
      where: {
        propertyId,
        roomId,
        status: { in: BLOCKING_STATUSES },
        checkIn: { lt: startOut },
        checkOut: { gt: startIn },
      },
      select: { confirmationNumber: true },
    });
    if (overlap)
      return NextResponse.json(
        { error: `Room ${room.number} is not available for these dates (conflicts with ${overlap.confirmationNumber})` },
        { status: 409 }
      );
  } else if (roomTypeId) {
    const rt = await db.roomType.findFirst({ where: { id: roomTypeId, propertyId } });
    if (!rt) return NextResponse.json({ error: "Room type not found" }, { status: 404 });
  } else {
    return NextResponse.json({ error: "A roomId or roomTypeId is required" }, { status: 400 });
  }

  const ratePlanId = body.ratePlanId ? String(body.ratePlanId) : null;
  if (ratePlanId) {
    const plan = await db.ratePlan.findFirst({ where: { id: ratePlanId, propertyId } });
    if (!plan) return NextResponse.json({ error: "Rate plan not found" }, { status: 404 });
  }

  const grossTotal = Math.round(nights * nightlyRate * 100) / 100;

  // Optional promo code — validated the same way as the booking engine.
  let promoCode = "";
  let discountAmount = 0;
  const promoInput = String(body.promoCode ?? "").trim();
  if (promoInput) {
    const promoCheck = await validatePromo(promoInput, grossTotal);
    if (!promoCheck.valid)
      return NextResponse.json({ error: `Promo code: ${promoCheck.message}` }, { status: 422 });
    promoCode = promoCheck.code ?? promoInput.toUpperCase();
    discountAmount = promoCheck.discount ?? 0;
  }

  const totalAmount = Math.round((grossTotal - discountAmount) * 100) / 100;
  const confirmationNumber = await uniqueConfirmationNumber();

  const reservation = await db.reservation.create({
    data: {
      propertyId,
      confirmationNumber,
      guestId,
      roomId,
      roomTypeId: roomTypeId ?? null,
      status: finalStatus,
      source,
      checkIn: startIn,
      checkOut: startOut,
      nights,
      adults,
      children,
      ratePlanId,
      nightlyRate,
      totalAmount,
      discountAmount,
      promoCode,
      notes: String(body.notes ?? ""),
      groupCode: String(body.groupCode ?? ""),
    },
    include: {
      guest: { select: { id: true, fullName: true, phone: true, email: true, photoUrl: true } },
      room: { include: { roomType: { select: { name: true, code: true } } } },
      roomType: { select: { name: true, code: true } },
    },
  });

  // Consume the promo redemption (best-effort — booking already succeeded).
  if (promoCode) {
    await db.promoCode.updateMany({
      where: { code: { in: [promoInput, promoCode] } },
      data: { usedCount: { increment: 1 } },
    }).catch(() => {});
  }

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "RESERVATION_CREATE",
    entity: "Reservation",
    entityId: reservation.id,
    details: `${finalStatus === "hold" ? "Hold" : "Booking"} ${confirmationNumber} — ${guest.fullName}, ${nights} night(s) · ₹${nightlyRate}/night${roomId ? ` · room ${reservation.room?.number ?? "?"}` : " · room unassigned"}${body.groupCode ? ` · group ${body.groupCode}` : ""}${promoCode ? ` · promo ${promoCode} (−₹${discountAmount})` : ""}`,
  });

  return NextResponse.json({ reservation }, { status: 201 });
}
