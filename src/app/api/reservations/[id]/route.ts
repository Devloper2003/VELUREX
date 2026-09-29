import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

const BLOCKING_STATUSES = ["confirmed", "checked_in", "hold"];
const RES_STATUSES = ["hold", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"];

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/reservations/[id] — single reservation with print-sensitive fields
 * (guest photo, captured ID-proof data URL) for registration cards.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const reservation = await db.reservation.findFirst({
    where: { id, propertyId },
    include: {
      guest: { select: { id: true, fullName: true, phone: true, email: true, photoUrl: true, idType: true, idNumber: true } },
      room: { include: { roomType: { select: { id: true, name: true, code: true } } } },
      roomType: { select: { id: true, name: true, code: true, baseRate: true } },
    },
  });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });

  return NextResponse.json({
    reservation: {
      ...reservation,
      // Keep the heavy data URL only when explicitly requested.
      idProofData: new URL(req.url).searchParams.get("withIdProof") === "1" ? reservation.idProofData : "",
    },
  });
}

/**
 * PATCH /api/reservations/[id] — modify a reservation.
 * Recomputes nights/total when dates or rate change; re-runs the availability
 * check (excluding self) when room or dates change. checked_out is not allowed
 * here — use POST /api/reservations/[id]/check-out instead.
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const reservation = await db.reservation.findFirst({
    where: { id, propertyId },
    include: { guest: { select: { id: true, fullName: true } }, room: true },
  });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  let newCheckIn = reservation.checkIn;
  let newCheckOut = reservation.checkOut;
  let newRoomId = reservation.roomId;

  if (body.checkIn !== undefined) {
    const d = new Date(body.checkIn);
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid checkIn date" }, { status: 400 });
    newCheckIn = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    data.checkIn = newCheckIn;
  }
  if (body.checkOut !== undefined) {
    const d = new Date(body.checkOut);
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid checkOut date" }, { status: 400 });
    newCheckOut = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    data.checkOut = newCheckOut;
  }
  if (newCheckOut <= newCheckIn)
    return NextResponse.json({ error: "Check-out date must be after check-in date" }, { status: 400 });

  if (body.roomId !== undefined) {
    if (body.roomId === null || body.roomId === "") {
      newRoomId = null;
      data.roomId = null;
    } else {
      const room = await db.room.findFirst({
        where: { id: String(body.roomId), propertyId },
        include: { roomType: true },
      });
      if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
      if (room.status === "out_of_order")
        return NextResponse.json({ error: `Room ${room.number} is out of order` }, { status: 409 });
      newRoomId = room.id;
      data.roomId = room.id;
      data.roomTypeId = room.roomTypeId;
    }
  }

  const datesChanged = newCheckIn.getTime() !== reservation.checkIn.getTime() || newCheckOut.getTime() !== reservation.checkOut.getTime();
  const roomChanged = newRoomId !== reservation.roomId;

  // Availability check only applies when a concrete room is involved — two
  // UNASSIGNED reservations (roomId null) can never conflict with each other;
  // they get a room (with a real availability check) at check-in time.
  if ((datesChanged || roomChanged) && newRoomId) {
    const overlap = await db.reservation.findFirst({
      where: {
        propertyId,
        id: { not: id },
        roomId: newRoomId,
        status: { in: BLOCKING_STATUSES },
        checkIn: { lt: newCheckOut },
        checkOut: { gt: newCheckIn },
      },
      select: { confirmationNumber: true },
    });
    if (overlap)
      return NextResponse.json(
        { error: `Room is not available for these dates (conflicts with ${overlap.confirmationNumber})` },
        { status: 409 }
      );
  }

  // Repricing helper — promo-aware: totalAmount always nets the booking discount
  // so the folio (room charges gross − discount credit) still matches the quote.
  // If the new gross drops BELOW the discount (drastic shortening / rate cut),
  // the discount is clamped to the gross so the folio can never go negative.
  const effectiveNights = () =>
    Math.max(1, Math.round((newCheckOut.getTime() - newCheckIn.getTime()) / 86400000));
  let repriced = false;
  let discountClamped = false;
  if (datesChanged) {
    data.nights = effectiveNights();
    repriced = true;
  }
  if (body.nightlyRate !== undefined) {
    const nightlyRate = Number(body.nightlyRate);
    if (Number.isNaN(nightlyRate) || nightlyRate <= 0)
      return NextResponse.json({ error: "Nightly rate must be a positive number" }, { status: 400 });
    data.nightlyRate = nightlyRate;
    repriced = true;
  }
  if (repriced) {
    const nights = (data.nights as number) ?? reservation.nights;
    const rate = (data.nightlyRate as number | undefined) ?? reservation.nightlyRate;
    const gross = Math.round(nights * rate * 100) / 100;
    const discount = reservation.promoCode ? reservation.discountAmount : 0;
    if (discount > 0 && discount >= gross) {
      data.discountAmount = gross; // clamp so the folio can never go negative
      data.totalAmount = 0;
      discountClamped = discount > gross;
    } else {
      data.totalAmount = Math.round((gross - discount) * 100) / 100;
    }
  }
  if (body.adults !== undefined) {
    const adults = Number(body.adults);
    if (Number.isNaN(adults) || adults < 1) return NextResponse.json({ error: "Adults must be at least 1" }, { status: 400 });
    data.adults = adults;
  }
  if (body.children !== undefined) {
    const children = Number(body.children);
    if (Number.isNaN(children) || children < 0) return NextResponse.json({ error: "Children cannot be negative" }, { status: 400 });
    data.children = children;
  }
  if (body.notes !== undefined) data.notes = String(body.notes ?? "");

  let statusChangedTo = "";
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!RES_STATUSES.includes(status))
      return NextResponse.json({ error: `Status must be one of: ${RES_STATUSES.join(", ")}` }, { status: 400 });
    if (status === "checked_out")
      return NextResponse.json({ error: "Use the check-out endpoint (POST /api/reservations/[id]/check-out) to check out" }, { status: 400 });
    if (status === "cancelled" && reservation.status === "checked_in")
      return NextResponse.json({ error: "Cannot cancel a checked-in reservation — check the guest out instead" }, { status: 409 });
    if (status === "checked_in")
      return NextResponse.json({ error: "Use the check-in endpoint (POST /api/reservations/[id]/check-in) to check in" }, { status: 400 });
    if (status !== reservation.status) statusChangedTo = status;
    data.status = status;
  }

  const updated = await db.reservation.update({
    where: { id },
    data,
    include: {
      guest: { select: { id: true, fullName: true, phone: true, email: true } },
      room: { include: { roomType: { select: { id: true, name: true, code: true } } } },
      roomType: { select: { id: true, name: true, code: true, baseRate: true } },
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: statusChangedTo === "cancelled" ? "RESERVATION_CANCEL" : statusChangedTo ? "RESERVATION_STATUS" : "RESERVATION_UPDATE",
    entity: "Reservation",
    entityId: id,
    details: [
      statusChangedTo ? `status → ${statusChangedTo}` : "",
      datesChanged ? `dates → ${updated.checkIn.toISOString().slice(0, 10)} → ${updated.checkOut.toISOString().slice(0, 10)}` : "",
      roomChanged ? `room → ${updated.room?.number ?? "unassigned"}` : "",
      data.nightlyRate !== undefined ? `rate → ₹${data.nightlyRate}` : "",
      repriced ? `total → ₹${data.totalAmount}${reservation.promoCode ? ` (incl. ${reservation.promoCode} −₹${data.discountAmount ?? reservation.discountAmount})` : ""}` : "",
      discountClamped ? "discount clamped to new gross" : "",
      body.notes !== undefined ? "notes edited" : "",
    ]
      .filter(Boolean)
      .join(" · ") || `Updated ${reservation.confirmationNumber}`,
  });

  return NextResponse.json({ reservation: updated });
}
