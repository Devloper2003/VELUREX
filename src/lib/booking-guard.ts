import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { rateForDate, GST_RATE, logActivity } from "@/lib/business";
import { buildTemplateBody, getWhatsAppSettings, sendWhatsApp } from "@/lib/whatsapp";
import {
  BLOCKING_STATUSES,
  MAX_NIGHTS,
  bestPlanForDate,
  nightDates,
  round2,
  toISODate,
  validatePromo,
} from "@/app/api/booking-engine/_shared";

/**
 * Booking race-condition guard — the answer to "what if two guests book the
 * same last room at the same moment?" and "what if the payment fails midway?".
 *
 * Layers (all server-side, the browser is never trusted):
 *
 *  1. WRITE-LOCK SERIALIZATION — every booking path opens an interactive
 *     SQLite transaction whose FIRST statement is the hold INSERT itself.
 *     That insert acquires the database write lock before any availability
 *     read happens, so two concurrent "1 room left" bookings are strictly
 *     ordered: the loser re-reads availability AFTER the winner committed
 *     and gets a clean 409 instead of a double-sell.
 *
 *  2. TIME-BOXED INVENTORY HOLDS — a hold reserves one room of a type for a
 *     fixed TTL (10 min) while the guest is on the payment page. Availability
 *     everywhere (search, hold, staff calendar) subtracts active holds, so
 *     nobody else can sell the room out from under the paying guest.
 *
 *  3. IDEMPOTENCY KEYS — holds are unique by `idempotencyKey`. A retried
 *     request (double-tap, flaky network, retry storm) returns the SAME hold
 *     instead of reserving a second room. Payment confirms are claimed via a
 *     status-guarded updateMany, so a duplicated gateway callback can never
 *     create two reservations.
 *
 *  4. DETERMINISTIC RELEASE — payment decline releases the hold instantly;
 *     abandoned checkouts are reclaimed by the TTL sweeper (called from the
 *     worker tick and before every hold read) — inventory never leaks.
 *
 *  5. ATOMIC PROMO REDEMPTION — usedCount is incremented with a
 *     `usedCount < maxUses` guard, so 50 concurrent users cannot burn a
 *     20-use code (carried over from the booking endpoint).
 */

export type Tx = Prisma.TransactionClient;
export type DbLike = PrismaClient | Tx;

export const HOLD_TTL_MINUTES = 10;

/* ─── Errors mapped to HTTP responses by the routes ──────────────────────── */

export class SoldOutError extends Error {
  constructor(message = "Sold out — another guest just took the last room for these dates.") {
    super(message);
    this.name = "SoldOutError";
  }
}
export class HoldExpiredError extends Error {
  constructor(message = "Your room hold expired — the room was released. Please search again.") {
    super(message);
    this.name = "HoldExpiredError";
  }
}
export class HoldStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldStateError";
  }
}

/* ─── Availability (holds-aware) ─────────────────────────────────────────── */

export interface HoldInput {
  propertyId: string;
  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
  adults?: number;
  children?: number;
  guestName?: string;
  guestPhone?: string;
  promoCode?: string;
  idempotencyKey: string;
  tag?: string;
}

/**
 * Worst-night availability for ONE room type, subtracting both blocking
 * reservations and ACTIVE (unexpired) holds. Safe to run inside a tx.
 */
async function typeAvailability(
  dbLike: DbLike,
  propertyId: string,
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date,
  excludeHoldId?: string
): Promise<{ sellable: number; available: number }> {
  const nights = nightDates(checkIn, checkOut);
  const [rt, overlaps, activeHolds] = await Promise.all([
    dbLike.roomType.findUnique({
      where: { id: roomTypeId },
      include: { rooms: { select: { id: true, status: true } } },
    }),
    dbLike.reservation.findMany({
      where: {
        propertyId,
        status: { in: BLOCKING_STATUSES },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      select: { roomId: true, roomTypeId: true, checkIn: true, checkOut: true },
    }),
    dbLike.bookingHold.findMany({
      where: {
        propertyId,
        roomTypeId,
        status: "active",
        expiresAt: { gt: new Date() },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      select: { id: true, checkIn: true, checkOut: true },
    }),
  ]);
  if (!rt) return { sellable: 0, available: 0 };

  const sellable = rt.rooms.filter((r) => r.status !== "out_of_order");
  const sellableIds = new Set(sellable.map((r) => r.id));

  let minAvailable = sellable.length;
  for (const night of nights) {
    const nightEnd = new Date(night.getTime() + 86400000);
    const blockedRooms = new Set<string>();
    let unassigned = 0;
    for (const o of overlaps) {
      if (!(o.checkIn < nightEnd && o.checkOut > night)) continue;
      if (o.roomId) {
        if (sellableIds.has(o.roomId)) blockedRooms.add(o.roomId);
      } else if (o.roomTypeId === roomTypeId) {
        unassigned++;
      }
    }
    const holdsHere = activeHolds.filter((h) => h.id !== excludeHoldId && h.checkIn < nightEnd && h.checkOut > night).length;
    minAvailable = Math.min(minAvailable, Math.max(0, sellable.length - blockedRooms.size - unassigned - holdsHere));
  }
  return { sellable: sellable.length, available: Math.max(0, minAvailable) };
}

/**
 * Public availability read used by the search endpoint — sweeps first so the
 * storefront never sees stale holds.
 */
export async function availabilityForType(
  propertyId: string,
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date
) {
  await sweepExpiredHolds(propertyId);
  return typeAvailability(db, propertyId, roomTypeId, checkIn, checkOut);
}

/* ─── Authoritative pricing (rate-lock at hold time) ─────────────────────── */

async function quoteStay(propertyId: string, roomTypeId: string, checkIn: Date, checkOut: Date, promoCode?: string) {
  const [rt, plans] = await Promise.all([
    db.roomType.findUnique({ where: { id: roomTypeId } }),
    db.ratePlan.findMany({ where: { propertyId, active: true }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!rt) throw new Error("Room type not found");

  const nights = nightDates(checkIn, checkOut);
  const nightlyRates = nights.map((d) => {
    const plan = bestPlanForDate(plans, roomTypeId, d);
    return { date: toISODate(d), rate: round2(rateForDate(rt.baseRate, plan, d)) };
  });
  const roomTotal = round2(nightlyRates.reduce((s, r) => s + r.rate, 0));

  let discount = 0;
  let promoApplied: string | null = null;
  if (promoCode) {
    const check = await validatePromo(promoCode, roomTotal);
    if (check.valid) {
      discount = check.discount ?? 0;
      promoApplied = check.code ?? null;
    }
  }
  const netRoomTotal = round2(Math.max(0, roomTotal - discount));
  const taxAmount = round2(netRoomTotal * (GST_RATE / 100));
  return { rt, nightlyRates, avgRate: nightlyRates.length ? round2(roomTotal / nightlyRates.length) : 0, roomTotal, discount, promoApplied, netRoomTotal, taxAmount, grandTotal: round2(netRoomTotal + taxAmount) };
}

/* ─── Phase A: create the hold (idempotent + race-safe) ──────────────────── */

export interface CreateHoldResult {
  hold: {
    id: string;
    status: string;
    expiresAt: Date;
    roomTypeId: string;
    checkIn: Date;
    checkOut: Date;
    nights: number;
    grandTotal: number;
    totalAmount: number;
    taxAmount: number;
    discountAmount: number;
    promoCode: string | null;
  };
  duplicate: boolean; // true = an existing hold was returned for the same idempotency key
}

/**
 * Creates a 10-minute inventory hold inside a write-locked transaction.
 * The hold INSERT is the transaction's first statement: it (a) acquires the
 * SQLite write lock BEFORE any availability read, and (b) enforces
 * idempotency via the unique `idempotencyKey` (P2002 → return the existing
 * hold instead of reserving a second room).
 */
export async function createBookingHold(input: HoldInput): Promise<CreateHoldResult> {
  const nights = nightDates(input.checkIn, input.checkOut).length;
  if (nights < 1) throw new Error("At least one night is required");
  if (nights > MAX_NIGHTS) throw new Error(`Bookings are limited to ${MAX_NIGHTS} nights`);

  const expiresAt = new Date(Date.now() + HOLD_TTL_MINUTES * 60000);

  // Quote + promo validation happen outside the tx (reads only); the numbers
  // are persisted on the hold inside the tx, becoming the locked-in price.
  const quote = await quoteStay(input.propertyId, input.roomTypeId, input.checkIn, input.checkOut, input.promoCode);
  if (input.adults && quote.rt && input.adults > quote.rt.maxOccupancy) {
    throw new Error(`${quote.rt.name} sleeps a maximum of ${quote.rt.maxOccupancy} guests`);
  }

  const hold = await db.$transaction(async (tx) => {
    // 1st statement — write lock + idempotency gate. Losing concurrent
    // requests either queue behind this write (then re-check availability
    // against committed state) or hit the unique key (→ same hold returned).
    const created = await tx.bookingHold.create({
      data: {
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights,
        adults: Math.max(1, input.adults ?? 1),
        children: Math.max(0, input.children ?? 0),
        guestName: input.guestName ?? "",
        guestPhone: input.guestPhone ?? "",
        status: "active",
        idempotencyKey: input.idempotencyKey,
        totalAmount: quote.netRoomTotal,
        discountAmount: quote.discount,
        promoCode: quote.promoApplied ?? "",
        taxAmount: quote.taxAmount,
        grandTotal: quote.grandTotal,
        tag: input.tag ?? "",
        expiresAt,
      },
    });

    // Write lock is ours — availability is now race-free: any concurrent
    // booking either committed before this tx started (visible here) or is
    // queued behind it.
    const { available } = await typeAvailability(
      tx, input.propertyId, input.roomTypeId, input.checkIn, input.checkOut, created.id
    );
    if (available <= 0) {
      throw new SoldOutError(
        `${quote.rt?.name ?? "This room type"} just sold out for ${toISODate(input.checkIn)} → ${toISODate(input.checkOut)}. Please pick different dates or room type.`
      );
    }
    return created;
  }).catch(async (e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Idempotent replay: same key → return the original hold.
      const existing = await db.bookingHold.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        return { __duplicate: true as const, hold: existing };
      }
    }
    throw e;
  });

  if ("__duplicate" in hold) {
    return { hold: hold.hold, duplicate: true };
  }

  await logActivity({
    propertyId: input.propertyId,
    staffName: "Booking Engine",
    action: "HOLD_CREATED",
    entity: "BookingHold",
    entityId: hold.id,
    details: `Inventory hold ${hold.id.slice(-6).toUpperCase()} — ${input.guestName || "guest"} · ${nights} night(s) from ${toISODate(input.checkIn)} · ₹${quote.grandTotal} locked · expires ${expiresAt.toLocaleTimeString("en-IN")}`,
  });

  return { hold, duplicate: false };
}

/* ─── Phase B: settle the payment (confirm / decline / abandon) ──────────── */

export interface SettleResult {
  outcome: "confirmed" | "declined" | "released";
  hold: { id: string; status: string; reservationId: string };
  reservation?: {
    id: string; confirmationNumber: string; totalAmount: number; paidAmount: number; guestName: string; roomTypeName: string;
  };
  duplicate?: boolean;
}

/**
 * Confirms a held room after a successful payment.
 *
 * The reservation is claimed with a status-guarded `updateMany`
 * (active + unexpired → redeemed): only ONE of N concurrent confirms can
 * flip the row, so a duplicated gateway callback can never create two
 * reservations or double-charge — the losers detect `count === 0` and are
 * answered with the winner's reservation instead.
 */
export async function confirmHoldPayment(opts: {
  holdId: string;
  gatewayRef?: string;
  paymentMethod?: string;
  payNow?: boolean; // false = pay-at-hotel (reservation still created, paidAmount 0)
}): Promise<SettleResult> {
  const claimed = await db.$transaction(async (tx) => {
    // Claim attempt: atomic status flip guarded on "active and unexpired".
    const claimed = await tx.bookingHold.updateMany({
      where: { id: opts.holdId, status: "active", expiresAt: { gt: new Date() } },
      data: { status: "redeemed", gatewayRef: opts.gatewayRef ?? "pay-at-hotel" },
    });
    if (claimed.count === 0) return null;

    const hold = await tx.bookingHold.findUnique({ where: { id: opts.holdId } });
    if (!hold) return null;

    // Guest reuse-by-phone + reservation creation — same transaction, so the
    // reservation can never exist without the hold being marked redeemed.
    let guest = await tx.guest.findFirst({
      where: { propertyId: hold.propertyId, phone: hold.guestPhone },
    });
    if (!guest) {
      guest = await tx.guest.create({
        data: {
          propertyId: hold.propertyId,
          fullName: hold.guestName || "Online Guest",
          phone: hold.guestPhone,
          email: "",
        },
      });
    }

    let confirmationNumber = `RG-${Date.now().toString().slice(-8)}`;
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? confirmationNumber : `${confirmationNumber}-${i}`;
      const exists = await tx.reservation.findUnique({ where: { confirmationNumber: candidate } });
      if (!exists) { confirmationNumber = candidate; break; }
    }

    const reservation = await tx.reservation.create({
      data: {
        propertyId: hold.propertyId,
        confirmationNumber,
        guestId: guest.id,
        roomTypeId: hold.roomTypeId,
        status: "confirmed",
        source: "booking_engine",
        checkIn: hold.checkIn,
        checkOut: hold.checkOut,
        nights: hold.nights,
        adults: hold.adults,
        children: hold.children,
        nightlyRate: hold.nights > 0 ? round2(hold.totalAmount / hold.nights) : 0,
        totalAmount: hold.totalAmount,
        discountAmount: hold.discountAmount,
        promoCode: hold.promoCode,
        paidAmount: opts.payNow ? hold.grandTotal : 0,
        notes: `Online booking · hold ${hold.id.slice(-6).toUpperCase()} · gateway ref ${opts.gatewayRef || "pay-at-hotel"}${hold.promoCode ? ` · promo ${hold.promoCode} (-₹${hold.discountAmount})` : ""}`,
      },
    });

    await tx.bookingHold.update({
      where: { id: hold.id },
      data: { reservationId: reservation.id },
    });

    // Payment ledger row (Razorpay-shaped) when money actually moved.
    if (opts.payNow) {
      await tx.payment.create({
        data: {
          propertyId: hold.propertyId,
          reservationId: reservation.id,
          amount: hold.grandTotal,
          method: opts.paymentMethod ?? "razorpay",
          status: "success",
          reference: opts.gatewayRef ?? "",
          receivedBy: "booking_engine",
        },
      });
    }

    // Promo redemption is consumed only when the booking actually happens.
    if (hold.promoCode) {
      const promo = await tx.promoCode.findFirst({ where: { code: hold.promoCode } });
      if (promo) {
        await tx.promoCode.updateMany({
          where: { id: promo.id, usedCount: { lt: promo.maxUses } },
          data: { usedCount: { increment: 1 } },
        });
      }
    }

    return { hold, reservation, guest };
  }).catch(async (e) => {
    // Unique confirmation number collision retried by caller — practically
    // unreachable (ms timestamp + suffix loop); surface as a clean error.
    throw e;
  });

  if (!claimed) {
    // Lost the claim race — find out why and answer precisely.
    const hold = await db.bookingHold.findUnique({ where: { id: opts.holdId } });
    if (!hold) throw new HoldStateError("Hold not found");
    if (hold.status === "redeemed" && hold.reservationId) {
      // Idempotent replay of a successful payment — return the same reservation.
      const r = await db.reservation.findUnique({
        where: { id: hold.reservationId },
        include: { guest: true, roomType: true },
      });
      if (r) {
        return {
          outcome: "confirmed",
          duplicate: true,
          hold: { id: hold.id, status: hold.status, reservationId: r.id },
          reservation: {
            id: r.id, confirmationNumber: r.confirmationNumber, totalAmount: r.totalAmount,
            paidAmount: r.paidAmount, guestName: r.guest.fullName, roomTypeName: r.roomType?.name ?? "",
          },
        };
      }
    }
    if (hold.status === "expired" || (hold.status === "active" && hold.expiresAt <= new Date())) {
      await sweepExpiredHolds(hold.propertyId);
      throw new HoldExpiredError();
    }
    throw new HoldStateError(`Hold is ${hold.status} — no reservation can be created from it.`);
  }

  const { hold, reservation, guest } = claimed;
  const roomType = await db.roomType.findUnique({ where: { id: hold.roomTypeId } });

  // Post-commit side effects (never block or roll back the booking). The
  // confirmation message honours the tenant's template customization and can
  // be switched off entirely (WhatsApp tab → Booking Confirmation → Auto off).
  const waSettings = await getWhatsAppSettings(hold.propertyId);
  const message = waSettings.automation.booking_confirmation
    ? await sendWhatsApp({
        propertyId: hold.propertyId,
        toPhone: guest.phone,
        templateName: "booking_confirmation",
        body: buildTemplateBody(
          "booking_confirmation",
          {
            hotel: (await db.property.findUnique({ where: { id: hold.propertyId } }))?.name ?? "the hotel",
            guest: guest.fullName,
            confirmation: reservation.confirmationNumber,
            checkin: hold.checkIn,
            room: roomType?.name ?? "",
            nights: hold.nights,
            amount: hold.grandTotal,
          },
          waSettings
        ),
        reservationId: reservation.id,
      })
    : null;

  await logActivity({
    propertyId: hold.propertyId,
    staffName: "Booking Engine",
    action: "BOOKING_ONLINE",
    entity: "Reservation",
    entityId: reservation.id,
    details: `Online booking ${reservation.confirmationNumber} — ${guest.fullName} · ${roomType?.name ?? ""} · ${hold.nights} night(s) · ₹${hold.grandTotal}${opts.payNow ? " paid (guard-confirmed)" : " pay at hotel"}${hold.promoCode ? ` · promo ${hold.promoCode}` : ""}`,
  });
  void message;

  return {
    outcome: "confirmed",
    hold: { id: hold.id, status: "redeemed", reservationId: reservation.id },
    reservation: {
      id: reservation.id,
      confirmationNumber: reservation.confirmationNumber,
      totalAmount: reservation.totalAmount,
      paidAmount: reservation.paidAmount,
      guestName: guest.fullName,
      roomTypeName: roomType?.name ?? "",
    },
  };
}

/**
 * Marks a payment as FAILED: the hold is released atomically (status-guarded
 * updateMany again) so the room re-enters availability immediately, and a
 * failed Payment ledger row is written for the audit trail.
 */
export async function declineHoldPayment(opts: { holdId: string; gatewayRef?: string; reason?: string }): Promise<SettleResult> {
  const claimed = await db.$transaction(async (tx) => {
    const claimed = await tx.bookingHold.updateMany({
      where: { id: opts.holdId, status: "active" },
      data: { status: "released" },
    });
    if (claimed.count === 0) return null;
    const hold = await tx.bookingHold.findUnique({ where: { id: opts.holdId } });
    if (!hold) return null;
    await tx.payment.create({
      data: {
        propertyId: hold.propertyId,
        amount: hold.grandTotal,
        method: "razorpay",
        status: "failed",
        reference: opts.gatewayRef ?? "",
        receivedBy: "booking_engine",
      },
    });
    return hold;
  });

  if (!claimed) {
    const hold = await db.bookingHold.findUnique({ where: { id: opts.holdId } });
    if (hold && (hold.status === "released" || hold.status === "expired")) {
      return { outcome: "declined", duplicate: true, hold: { id: hold.id, status: hold.status, reservationId: hold.reservationId } };
    }
    throw new HoldStateError("Hold not found or already redeemed — cannot decline.");
  }

  await logActivity({
    propertyId: claimed.propertyId,
    staffName: "Booking Engine",
    action: "PAYMENT_FAILED",
    entity: "BookingHold",
    entityId: claimed.id,
    details: `Payment declined (${opts.reason || "gateway error"}) for hold ${claimed.id.slice(-6).toUpperCase()} — hold released instantly, ${claimed.nights} night(s) from ${toISODate(claimed.checkIn)} back in inventory`,
  });

  return { outcome: "declined", hold: { id: claimed.id, status: "released", reservationId: "" } };
}

/** Guest abandons the checkout / stress-test cleanup — free the room now. */
export async function releaseHold(holdId: string, reason = "abandoned"): Promise<boolean> {
  const res = await db.bookingHold.updateMany({
    where: { id: holdId, status: "active" },
    data: { status: "released" },
  });
  if (res.count > 0) {
    const hold = await db.bookingHold.findUnique({ where: { id: holdId } });
    if (hold) {
      await logActivity({
        propertyId: hold.propertyId,
        staffName: "Booking Engine",
        action: "HOLD_RELEASED",
        entity: "BookingHold",
        entityId: hold.id,
        details: `Hold ${hold.id.slice(-6).toUpperCase()} released (${reason}) — inventory restored`,
      });
    }
  }
  return res.count > 0;
}

/** TTL sweeper — reclaims inventory from abandoned checkouts. */
export async function sweepExpiredHolds(propertyId?: string): Promise<number> {
  const res = await db.bookingHold.updateMany({
    where: {
      status: "active",
      expiresAt: { lt: new Date() },
      ...(propertyId ? { propertyId } : {}),
    },
    data: { status: "expired" },
  });
  return res.count;
}

/** Frees every active stress-test hold (guard simulator cleanup). */
export async function releaseStressTestHolds(propertyId: string): Promise<number> {
  const res = await db.bookingHold.updateMany({
    where: { propertyId, status: "active", tag: "stress-test" },
    data: { status: "released" },
  });
  return res.count;
}
