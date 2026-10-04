import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";
import {
  SoldOutError,
  createBookingHold,
  sweepExpiredHolds,
} from "@/lib/booking-guard";
import { parseDay, getPrimaryProperty, nightDates, resolveUpsells, applyUpsellsToHold, parseUpsellDetail } from "../_shared";

/**
 * POST /api/booking-engine/hold — phase A of the race-safe booking flow.
 *
 * Public. Reserves one unit of a room type for 10 minutes while the guest
 * pays. Availability is re-checked inside a write-locked transaction, so two
 * simultaneous "last room" requests resolve deterministically: one hold is
 * granted, the loser gets a clean 409 — never a double-sell. Retries with the
 * same `idempotencyKey` return the SAME hold (no second room reserved).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    roomTypeId?: string;
    checkIn?: string;
    checkOut?: string;
    adults?: number;
    children?: number;
    guestName?: string;
    guestPhone?: string;
    promoCode?: string;
    upsellIds?: string[];
    idempotencyKey?: string;
    tag?: string;
  } | null;

  if (!body?.roomTypeId) return NextResponse.json({ error: "roomTypeId is required" }, { status: 400 });
  const checkIn = parseDay(body.checkIn ?? null);
  const checkOut = parseDay(body.checkOut ?? null);
  if (!checkIn || !checkOut) return NextResponse.json({ error: "Valid checkIn and checkOut (YYYY-MM-DD) are required" }, { status: 400 });
  if (checkOut <= checkIn) return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });

  const property = await getPrimaryProperty(req.nextUrl.searchParams.get("property") ?? undefined);
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const rt = await db.roomType.findFirst({ where: { id: body.roomTypeId, propertyId: property.id } });
  if (!rt) return NextResponse.json({ error: "Room type not found" }, { status: 404 });

  // Minimum-stay policy — reject before reserving any inventory.
  const nights = nightDates(checkIn, checkOut).length;
  const minNights = Math.max(1, property.minNights || 1);
  if (nights < minNights) {
    return NextResponse.json(
      { error: `Minimum stay of ${minNights} nights required`, code: "MIN_NIGHTS" },
      { status: 422 }
    );
  }

  const adults = Math.max(1, Number(body.adults) || 1);

  try {
    const { hold, duplicate } = await createBookingHold({
      propertyId: property.id,
      roomTypeId: body.roomTypeId,
      checkIn,
      checkOut,
      adults,
      children: Math.max(0, Number(body.children) || 0),
      guestName: String(body.guestName ?? "").trim(),
      guestPhone: String(body.guestPhone ?? "").trim(),
      promoCode: body.promoCode ? String(body.promoCode).trim() : undefined,
      idempotencyKey: body.idempotencyKey?.trim() || `hold-${crypto.randomUUID()}`,
      tag: body.tag,
    });

    // Add-ons: validate ids against the property and fold the total into the
    // hold's locked price (rooms + upsells are taxed as one base). Holds
    // without add-ons are left untouched — bit-identical to the legacy flow.
    const upsells = await resolveUpsells(property.id, body.upsellIds, nights, adults);
    // The created hold carries upsell columns (defaults 0/"[]") even though the
    // guard's narrow result type omits them — widen so the priced row flows through.
    let priced = hold as typeof hold & { upsellAmount: number; upsellDetail: string };
    if (upsells.ids.length > 0) {
      const updated = await applyUpsellsToHold(hold.id, upsells.amount, upsells.detail);
      if (updated) priced = updated;
    }

    return NextResponse.json(
      {
        holdId: priced.id,
        status: priced.status,
        duplicate,
        expiresAt: priced.expiresAt,
        ttlSeconds: Math.max(0, Math.round((new Date(priced.expiresAt).getTime() - Date.now()) / 1000)),
        nights: priced.nights,
        roomTypeName: rt.name,
        totalAmount: priced.totalAmount,
        discountAmount: priced.discountAmount,
        promoApplied: priced.promoCode || null,
        upsellAmount: priced.upsellAmount,
        upsellDetail: parseUpsellDetail(priced.upsellDetail),
        taxAmount: priced.taxAmount,
        grandTotal: priced.grandTotal,
      },
      { status: duplicate ? 200 : 201 }
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not hold the room" }, { status: 400 });
  }
}

/**
 * GET /api/booking-engine/hold?id=… — public hold status poll used by the
 * checkout countdown. Sweeps first so an expired hold is reported as expired,
 * not active.
 */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  await sweepExpiredHolds();
  const hold = await db.bookingHold.findUnique({
    where: { id },
    include: { roomType: { select: { name: true, code: true } } },
  });
  if (!hold) return NextResponse.json({ error: "Hold not found" }, { status: 404 });

  return NextResponse.json({
    holdId: hold.id,
    status: hold.status,
    expiresAt: hold.expiresAt,
    secondsLeft: Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - Date.now()) / 1000)),
    roomTypeName: hold.roomType?.name ?? "",
    nights: hold.nights,
    grandTotal: hold.grandTotal,
    totalAmount: hold.totalAmount,
    taxAmount: hold.taxAmount,
    discountAmount: hold.discountAmount,
    promoApplied: hold.promoCode || null,
    upsellAmount: hold.upsellAmount,
    upsellDetail: parseUpsellDetail(hold.upsellDetail),
    reservationId: hold.reservationId || null,
  });
}
