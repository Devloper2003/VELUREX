import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";
import {
  SoldOutError,
  HoldExpiredError,
  confirmHoldPayment,
  createBookingHold,
} from "@/lib/booking-guard";
import { parseDay, getPrimaryProperty } from "../_shared";

/**
 * POST /api/booking-engine/book — public guest-facing booking endpoint.
 *
 * NOW RACE-SAFE: every booking — pay-at-hotel or pay-now — flows through the
 * guard (lib/booking-guard.ts): an idempotent, write-locked inventory hold
 * whose availability check runs inside the write lock, then an atomic
 * claim-based redemption into a reservation. Two guests hitting "book" on the
 * last room at the same moment resolve to exactly one confirmation.
 *
 * Client totals are never trusted: rates are re-derived from rate plans and
 * the price is locked onto the hold. Guest identity is reused by phone.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    guest?: { fullName?: string; phone?: string; email?: string; idType?: string; idNumber?: string };
    roomTypeId?: string;
    checkIn?: string;
    checkOut?: string;
    adults?: number;
    children?: number;
    promoCode?: string;
    paymentId?: string;
    mockPaid?: boolean;
    idempotencyKey?: string;
  } | null;

  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const fullName = String(body.guest?.fullName ?? "").trim();
  const phone = String(body.guest?.phone ?? "").trim();
  if (!fullName || !phone)
    return NextResponse.json({ error: "Guest full name and phone are required" }, { status: 400 });

  const checkIn = parseDay(body.checkIn ?? null);
  const checkOut = parseDay(body.checkOut ?? null);
  if (!checkIn || !checkOut)
    return NextResponse.json({ error: "Valid checkIn and checkOut (YYYY-MM-DD) are required" }, { status: 400 });
  if (checkOut <= checkIn)
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });

  if (!body.roomTypeId) return NextResponse.json({ error: "roomTypeId is required" }, { status: 400 });

  const property = await getPrimaryProperty();
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const paid = Boolean(body.paymentId || body.mockPaid);
  const paymentRef = body.paymentId ? String(body.paymentId) : body.mockPaid ? "mock" : "pay-at-hotel";

  try {
    // Phase A — idempotent, write-locked inventory hold (price locked here).
    const { hold } = await createBookingHold({
      propertyId: property.id,
      roomTypeId: body.roomTypeId,
      checkIn,
      checkOut,
      adults: Math.max(1, Number(body.adults) || 1),
      children: Math.max(0, Number(body.children) || 0),
      guestName: fullName,
      guestPhone: phone,
      promoCode: body.promoCode ? String(body.promoCode).trim() : undefined,
      idempotencyKey: body.idempotencyKey?.trim() || `book-${crypto.randomUUID()}`,
    });

    // Phase B — atomic claim → reservation (+ Payment row when paid).
    const settled = await confirmHoldPayment({
      holdId: hold.id,
      gatewayRef: paymentRef,
      payNow: paid,
    });
    if (!settled.reservation) throw new Error("Booking could not be confirmed — please try again.");

    const reservation = await db.reservation.findUnique({
      where: { id: settled.reservation.id },
      include: { guest: true },
    });

    return NextResponse.json(
      {
        confirmationNumber: settled.reservation.confirmationNumber,
        reservationId: settled.reservation.id,
        total: hold.grandTotal,
        paid: settled.reservation.paidAmount,
        whatsappStatus: "queued",
        roomTotal: hold.totalAmount + hold.discountAmount,
        discount: hold.discountAmount,
        taxAmount: hold.taxAmount,
        promoApplied: Boolean(hold.promoCode),
        promoCode: hold.promoCode || null,
        guestId: reservation?.guestId ?? "",
        holdId: hold.id,
        raceSafe: true,
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof SoldOutError) {
      await logActivity({
        propertyId: property.id,
        staffName: "Booking Engine",
        action: "BOOKING_REJECTED",
        entity: "RoomType",
        entityId: body.roomTypeId,
        details: `Oversale guard rejected a booking — ${e.message}`,
      });
      return NextResponse.json({ error: e.message, code: "SOLD_OUT" }, { status: 409 });
    }
    if (e instanceof HoldExpiredError) {
      return NextResponse.json({ error: e.message, code: "HOLD_EXPIRED" }, { status: 410 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Booking failed" }, { status: 400 });
  }
}
