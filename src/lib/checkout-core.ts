import { db } from "@/lib/db";
import { logActivity, startOfDay } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";

/**
 * Shared check-out engine — used by the single check-out endpoint
 * (POST /api/reservations/[id]/check-out) and the bulk group check-out
 * (POST /api/groups/[code]/check-out) so both paths apply exactly the same
 * money math: early-departure re-pricing, departure posting of unbilled
 * nights, over-billed-night credits and promo discount reconciliation.
 */

export interface CheckoutStaff {
  sub: string;
  name: string;
}

export interface CheckoutOutcome {
  ok: boolean;
  reservationId: string;
  confirmationNumber: string;
  guestName: string;
  roomNumber: string | null;
  folioTotal: number;
  paid: number;
  balance: number;
  departureRoomChargeNights: number;
  departureRoomCharge: number;
  discountPosted: boolean;
  earlyDeparture: { bookedNights: number; stayedNights: number; revisedTotal: number; revisedCheckOut: string; discountClamped: boolean } | null;
  error?: string;
}

/**
 * Performs the full check-out sequence for one reservation. Throws only on
 * precondition failures (not found / not checked in); money-path failures
 * propagate so callers can decide how to report them.
 */
export async function performCheckout(opts: {
  propertyId: string;
  reservationId: string;
  staff: CheckoutStaff;
}): Promise<CheckoutOutcome> {
  const { propertyId, reservationId, staff } = opts;

  const reservation = await db.reservation.findFirst({
    where: { id: reservationId, propertyId },
    include: {
      guest: true,
      room: { include: { roomType: { select: { name: true } } } },
    },
  });
  if (!reservation) throw new Error("Reservation not found");
  if (reservation.status !== "checked_in")
    throw new Error(
      `Only checked-in reservations can be checked out (current status: ${reservation.status.replace("_", " ")})`
    );

  // ── Early-departure reconciliation: a guest leaving before the booked
  // check-out date is billed for the nights ACTUALLY stayed (calendar nights
  // from check-in to today's business date, minimum 1). The reservation is
  // re-priced (nights, check-out, total — promo discount clamped to the new
  // gross) and any room nights over-billed by prior night audits are credited
  // back, so the folio always matches the revised stay.
  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { businessDate: true },
  });
  const businessDate = property?.businessDate ?? new Date();

  const bookedNights = reservation.nights;
  const departDay = startOfDay(businessDate);
  const checkInDay = startOfDay(reservation.checkIn);
  const stayedNights = Math.min(
    bookedNights,
    Math.max(1, Math.round((departDay.getTime() - checkInDay.getTime()) / 86400000)),
  );
  const earlyDeparture = stayedNights < bookedNights;
  let revisedTotal = reservation.totalAmount;
  let effectiveDiscount = reservation.discountAmount;
  if (earlyDeparture) {
    const gross = Math.round(stayedNights * reservation.nightlyRate * 100) / 100;
    effectiveDiscount = reservation.promoCode ? Math.min(reservation.discountAmount, gross) : 0;
    revisedTotal = Math.round((gross - effectiveDiscount) * 100) / 100;
  }

  // ── Departure posting: catch up on room charges the night audit has not
  // posted yet (same-day departures, or any stay that ends before the closing
  // night audit). Nights already billed on the folio are never double-posted.
  const priorItems = await db.folioItem.findMany({
    where: { reservationId, category: "room" },
    select: { qty: true },
  });
  const billedNights = priorItems.reduce((s, i) => s + i.qty, 0);
  const billableNights = earlyDeparture ? stayedNights : reservation.nights;

  // Credit back any nights the night audit already billed but the guest did
  // not stay (early departure). A negative-qty room line keeps the folio's
  // "billed nights" arithmetic self-consistent if this flow ever re-runs.
  if (billedNights > billableNights) {
    const creditNights = billedNights - billableNights;
    const creditAmount = Math.round(creditNights * reservation.nightlyRate * 100) / 100;
    await db.folioItem.create({
      data: {
        propertyId,
        reservationId,
        guestId: reservation.guestId,
        category: "room",
        description: `Early departure adjustment — ${creditNights} night(s) not stayed, credited`,
        qty: -creditNights,
        rate: reservation.nightlyRate,
        amount: -creditAmount,
        businessDate,
        postedBy: staff.name,
      },
    });
  }

  const unbilledNights = Math.max(0, billableNights - billedNights);
  let departureRoomCharge = 0;
  if (unbilledNights > 0) {
    departureRoomCharge = Math.round(unbilledNights * reservation.nightlyRate * 100) / 100;
    await db.folioItem.create({
      data: {
        propertyId,
        reservationId,
        guestId: reservation.guestId,
        category: "room",
        description: `Room charge — ${reservation.room?.number ?? "—"} (${reservation.room?.roomType?.name ?? "Room"})${billedNights > 0 ? " — departure posting" : ""}`,
        qty: unbilledNights,
        rate: reservation.nightlyRate,
        amount: departureRoomCharge,
        businessDate,
        postedBy: staff.name,
      },
    });
  }

  // ── Promo reconciliation: post the discount credit line so the folio (and
  // the GST invoice) net out to the same total the guest was quoted.
  // Room charges post gross (night audit + departure posting); the promo
  // discount is applied once, right before departure, as a 0%-GST negative line.
  // On early departure the discount is the CLAMPED value (never exceeds gross).
  let discountItemId: string | null = null;
  if (reservation.promoCode && effectiveDiscount > 0) {
    const existingDiscount = await db.folioItem.findFirst({
      where: { reservationId, category: "discount" },
      select: { id: true },
    });
    if (!existingDiscount) {
      const discount = Math.round(effectiveDiscount * 100) / 100;
      const discountItem = await db.folioItem.create({
        data: {
          propertyId,
          reservationId,
          guestId: reservation.guestId,
          category: "discount",
          description: `Promo discount — ${reservation.promoCode}`,
          qty: 1,
          rate: -discount,
          amount: -discount,
          businessDate,
          postedBy: staff.name,
        },
      });
      discountItemId = discountItem.id;
    }
  }

  const folioItems = await db.folioItem.findMany({ where: { reservationId } });
  const folioTotal = folioItems.reduce((sum, item) => sum + item.amount, 0);
  const balance = Math.round((folioTotal - reservation.paidAmount) * 100) / 100;

  const now = new Date();

  await db.$transaction([
    db.reservation.update({
      where: { id: reservationId },
      data: {
        status: "checked_out",
        checkedOutAt: now,
        // Early departure re-price — keep the reservation's dates/total in
        // step with what the guest actually stayed and owes.
        ...(earlyDeparture
          ? { nights: stayedNights, checkOut: departDay, totalAmount: revisedTotal, discountAmount: effectiveDiscount }
          : {}),
      },
    }),
    ...(reservation.roomId ? [db.room.update({ where: { id: reservation.roomId }, data: { status: "dirty" } })] : []),
  ]);

  await logActivity({
    propertyId,
    staffId: staff.sub,
    staffName: staff.name,
    action: "CHECK_OUT",
    entity: "Reservation",
    entityId: reservationId,
    details: `Checked out ${reservation.guest.fullName} — room ${reservation.room?.number ?? "?"} (${reservation.confirmationNumber}) · folio ₹${folioTotal.toFixed(2)} · balance ₹${balance.toFixed(2)}${earlyDeparture ? ` · EARLY DEPARTURE ${bookedNights}→${stayedNights} night(s), revised total ₹${revisedTotal.toFixed(2)}` : ""}${unbilledNights > 0 ? ` · ${unbilledNights} night(s) departure-posted` : ""}${discountItemId ? ` · promo ${reservation.promoCode} −₹${effectiveDiscount.toFixed(2)}` : ""}`,
  });

  // Live-push so open Billing views refresh instantly (best-effort).
  emitRealtime("global", "folio:update", {
    reservationId,
    kind: discountItemId ? "discount" : "checkout",
    itemId: discountItemId,
    amount: discountItemId ? -effectiveDiscount : departureRoomCharge,
  });

  return {
    ok: true,
    reservationId,
    confirmationNumber: reservation.confirmationNumber,
    guestName: reservation.guest.fullName,
    roomNumber: reservation.room?.number ?? null,
    folioTotal,
    paid: reservation.paidAmount,
    balance,
    departureRoomChargeNights: unbilledNights,
    departureRoomCharge,
    discountPosted: Boolean(discountItemId),
    earlyDeparture: earlyDeparture
      ? {
          bookedNights,
          stayedNights,
          revisedTotal,
          revisedCheckOut: departDay.toISOString().slice(0, 10),
          discountClamped: effectiveDiscount < reservation.discountAmount,
        }
      : null,
    error: undefined,
  };
}
