import { db } from "@/lib/db";
import { rateForDate } from "@/lib/business";

/**
 * Shared logic for the public booking engine — availability oracle, rate
 * quoting and promo validation. Used by /availability, /book and /promo so the
 * quote the guest sees is the same math the booking endpoint re-runs
 * authoritatively.
 */

export const BLOCKING_STATUSES = ["confirmed", "checked_in", "hold"];
export const MAX_NIGHTS = 31;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** The booking engine serves the property's public storefront — single-property install. */
export async function getPrimaryProperty() {
  return db.property.findFirst({ orderBy: { createdAt: "asc" } });
}

/** Parses a YYYY-MM-DD param into a local-midnight Date, or null. */
export function parseDay(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Nights the guest stays: checkIn (inclusive) … checkOut (exclusive). */
export function nightDates(checkIn: Date, checkOut: Date): Date[] {
  const out: Date[] = [];
  const cur = new Date(checkIn.getFullYear(), checkIn.getMonth(), checkIn.getDate());
  const end = new Date(checkOut.getFullYear(), checkOut.getMonth(), checkOut.getDate());
  while (cur < end && out.length < MAX_NIGHTS + 1) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function parseAmenities(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
}

/**
 * Best matching active rate plan for a room type on a given date:
 *  1. type-specific plans (newest first) always win;
 *  2. otherwise general plans with a date-specific override (weekend rate on
 *     Fri/Sat/Sun, then seasonal rate in range) — newest first;
 *  3. otherwise a "neutral" general plan that keeps the room-type base
 *     (baseRate 0/absent, e.g. Best Available Rate);
 *  4. fallback: any general plan.
 * The actual weekend/seasonal/base resolution happens inside rateForDate().
 */
export function bestPlanForDate<T extends { id: string; roomTypeId: string | null; weekendRate?: number | null; seasonalStart?: Date | null; seasonalEnd?: Date | null; seasonalRate?: number | null; baseRate?: number }>(
  plans: T[],
  roomTypeId: string,
  date: Date
): T | null {
  const isWeekendDay = (d: Date) => d.getDay() === 5 || d.getDay() === 6 || d.getDay() === 0;
  const seasonalCovers = (p: T, d: Date) =>
    Boolean(p.seasonalRate && p.seasonalStart && p.seasonalEnd && d >= p.seasonalStart && d <= p.seasonalEnd);

  const specific = plans.find((p) => p.roomTypeId === roomTypeId);
  if (specific) return specific;

  const general = plans.filter((p) => p.roomTypeId === null);
  return (
    general.find((p) => p.weekendRate && isWeekendDay(date)) ??
    general.find((p) => seasonalCovers(p, date)) ??
    general.find((p) => !(p.baseRate && p.baseRate > 0)) ??
    general[0] ??
    null
  );
}

export interface QuotedRoomType {
  id: string;
  name: string;
  code: string;
  description: string;
  amenities: string[];
  maxOccupancy: number;
  sizeSqft: number;
  bedType: string;
  baseRate: number;
  available: number;
  totalRooms: number;
  nightlyRates: { date: string; rate: number }[];
  avgRate: number;
  total: number;
}

/**
 * Availability + nightly rate quote for every room type across the stay.
 * Availability = rooms of the type (minus out-of-order) not blocked by an
 * overlapping reservation [confirmed | checked_in | hold] NOR by an active
 * booking-engine hold (race-condition guard), taking the worst night.
 */
export async function computeAvailability(checkIn: Date, checkOut: Date): Promise<{
  property: NonNullable<Awaited<ReturnType<typeof getPrimaryProperty>>>;
  roomTypes: QuotedRoomType[];
} | null> {
  const property = await getPrimaryProperty();
  if (!property) return null;

  const nights = nightDates(checkIn, checkOut);
  if (nights.length === 0) return null;

  const [roomTypes, plans, overlaps, activeHolds] = await Promise.all([
    db.roomType.findMany({
      where: { propertyId: property.id },
      include: { rooms: { select: { id: true, status: true } } },
      orderBy: { baseRate: "asc" },
    }),
    db.ratePlan.findMany({
      where: { propertyId: property.id, active: true },
      orderBy: { createdAt: "desc" },
    }),
    db.reservation.findMany({
      where: {
        propertyId: property.id,
        status: { in: BLOCKING_STATUSES },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      // roomId: reservation holds a concrete room; roomTypeId-only (booking
      // engine / unassigned): holds one unit of the type's inventory.
      select: { roomId: true, roomTypeId: true, checkIn: true, checkOut: true },
    }),
    // Race-condition guard: active payment holds consume inventory too.
    db.bookingHold.findMany({
      where: {
        propertyId: property.id,
        status: "active",
        expiresAt: { gt: new Date() },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      select: { roomTypeId: true, checkIn: true, checkOut: true },
    }),
  ]);

  const roomTypesQuoted: QuotedRoomType[] = roomTypes.map((rt) => {
    const sellable = rt.rooms.filter((r) => r.status !== "out_of_order");
    const sellableIds = new Set(sellable.map((r) => r.id));

    // Worst-night availability across the stay. Room-assigned reservations
    // block their concrete room; type-only reservations (booking engine)
    // consume one unit of the type's inventory; active holds do the same.
    let minAvailable = sellable.length;
    for (const night of nights) {
      const nightEnd = new Date(night.getTime() + 86400000);
      const live = overlaps.filter((o) => o.checkIn < nightEnd && o.checkOut > night);
      const blockedRooms = new Set<string>();
      let unassigned = 0;
      for (const o of live) {
        if (o.roomId) {
          if (sellableIds.has(o.roomId)) blockedRooms.add(o.roomId);
        } else if (o.roomTypeId === rt.id) {
          unassigned++;
        }
      }
      const holdsHere = activeHolds.filter(
        (h) => h.roomTypeId === rt.id && h.checkIn < nightEnd && h.checkOut > night
      ).length;
      minAvailable = Math.min(minAvailable, Math.max(0, sellable.length - blockedRooms.size - unassigned - holdsHere));
    }
    if (minAvailable < 0) minAvailable = 0;

    const nightlyRates = nights.map((d) => {
      const plan = bestPlanForDate(plans, rt.id, d);
      return { date: toISODate(d), rate: round2(rateForDate(rt.baseRate, plan, d)) };
    });
    const total = round2(nightlyRates.reduce((s, r) => s + r.rate, 0));

    return {
      id: rt.id,
      name: rt.name,
      code: rt.code,
      description: rt.description,
      amenities: parseAmenities(rt.amenities),
      maxOccupancy: rt.maxOccupancy,
      sizeSqft: rt.sizeSqft,
      bedType: rt.bedType,
      baseRate: rt.baseRate,
      totalRooms: sellable.length,
      available: minAvailable,
      nightlyRates,
      avgRate: nightlyRates.length ? round2(total / nightlyRates.length) : 0,
      total,
    };
  });

  return { property, roomTypes: roomTypesQuoted };
}

export interface PromoCheck {
  valid: boolean;
  message?: string;
  discount?: number;
  code?: string;
  description?: string;
}

/** Validates a promo code against the current moment and quotes its discount on `amount`. */
export async function validatePromo(code: string, amount: number): Promise<PromoCheck> {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return { valid: false, message: "Enter a promo code" };

  const promo =
    (await db.promoCode.findFirst({ where: { code: trimmed } })) ??
    (await db.promoCode.findFirst({ where: { code: trimmed.toUpperCase() } }));
  if (!promo) return { valid: false, message: "Invalid promo code" };

  const now = new Date();
  if (!promo.active) return { valid: false, message: "This promo code is no longer active" };
  if (now < promo.validFrom) return { valid: false, message: "This promo code is not valid yet" };
  if (now > promo.validTo) return { valid: false, message: "This promo code has expired" };
  if (promo.usedCount >= promo.maxUses)
    return { valid: false, message: "This promo code has been fully redeemed" };

  const discount =
    promo.discountType === "percent"
      ? round2((amount * promo.discountValue) / 100)
      : round2(Math.min(promo.discountValue, amount));

  return {
    valid: true,
    discount,
    code: promo.code,
    description: promo.description,
  };
}
