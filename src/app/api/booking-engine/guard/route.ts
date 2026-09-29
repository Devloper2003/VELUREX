import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import {
  SoldOutError,
  createBookingHold,
  releaseStressTestHolds,
  sweepExpiredHolds,
} from "@/lib/booking-guard";
import { parseDay, getPrimaryProperty } from "../_shared";

/**
 * GET /api/booking-engine/guard — admin telemetry for the oversale guard:
 * live holds, 24h lifecycle counters, failed payments, guard rejections and
 * the most recent hold events.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  await sweepExpiredHolds(propertyId);
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  const [activeHolds, lifecycle, failedPayments, rejected, recent, roomTypes] = await Promise.all([
    db.bookingHold.count({ where: { propertyId, status: "active" } }),
    db.bookingHold.groupBy({
      by: ["status"],
      where: { propertyId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.payment.count({ where: { propertyId, status: "failed", createdAt: { gte: since } } }),
    db.activityLog.count({ where: { propertyId, action: "BOOKING_REJECTED", createdAt: { gte: since } } }),
    db.bookingHold.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { roomType: { select: { name: true, code: true } } },
    }),
    db.roomType.findMany({ where: { propertyId }, orderBy: { baseRate: "asc" }, select: { id: true, name: true, code: true } }),
  ]);

  const life: Record<string, number> = { active: 0, redeemed: 0, released: 0, expired: 0 };
  for (const g of lifecycle) life[g.status] = g._count._all;

  return NextResponse.json({
    activeHolds,
    last24h: {
      created: life.active + life.redeemed + life.released + life.expired,
      redeemed: life.redeemed,
      released: life.released,
      expired: life.expired,
      failedPayments,
      rejected,
    },
    recentHolds: recent.map((h) => ({
      id: h.id,
      status: h.status,
      roomTypeName: h.roomType?.name ?? "",
      nights: h.nights,
      checkIn: h.checkIn,
      checkOut: h.checkOut,
      guestName: h.guestName,
      grandTotal: h.grandTotal,
      tag: h.tag,
      createdAt: h.createdAt,
      expiresAt: h.expiresAt,
    })),
    roomTypes,
  });
}

/**
 * POST /api/booking-engine/guard — guard simulator (hotel_admin):
 *   { action: "stress", roomTypeId, checkIn, checkOut?, attempts }
 *     → fires N truly parallel hold requests for the SAME room type & dates,
 *       exactly like N guests hitting "book" on the last room at once.
 *   { action: "cleanup-stress" }
 *     → releases every active stress-test hold, restoring the inventory.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    action?: "stress" | "cleanup-stress";
    roomTypeId?: string;
    checkIn?: string;
    checkOut?: string;
    attempts?: number;
  } | null;

  if (body?.action === "cleanup-stress") {
    const released = await releaseStressTestHolds(propertyId);
    await logActivity({
      propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "HOLD_RELEASED",
      entity: "BookingHold",
      details: `Guard simulator cleanup — ${released} stress-test hold${released === 1 ? "" : "s"} released`,
    });
    return NextResponse.json({ ok: true, released });
  }

  if (body?.action !== "stress" || !body.roomTypeId) {
    return NextResponse.json({ error: "action must be 'stress' (with roomTypeId) or 'cleanup-stress'" }, { status: 400 });
  }

  const attempts = Math.min(30, Math.max(2, Number(body.attempts) || 10));
  const checkIn = parseDay(body.checkIn ?? null);
  const checkOut = body.checkOut ? parseDay(body.checkOut) : null;
  if (!checkIn) return NextResponse.json({ error: "checkIn is required" }, { status: 400 });
  const finalCheckOut = checkOut && checkOut > checkIn ? checkOut : new Date(checkIn.getTime() + 86400000);

  const property = await getPrimaryProperty();
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const batch = `stress-${Date.now().toString(36)}`;
  const runId = batch;
  const targetRoomType = body.roomTypeId;
  const drillCheckIn = checkIn;
  const drillCheckOut = finalCheckOut;

  // Real guests don't arrive on the same millisecond — the burst spreads over
  // ~1.2s (still heavily overlapping). SQLite is a single-writer engine, so
  // under deep contention a request can outlive the DB socket timeout before
  // it even gets the lock; those retry (like a real gateway would) instead of
  // surfacing an infra error as a fake "rejection".
  const isDbTimeout = (e: unknown) =>
    e instanceof Error && /socket timeout|timed out|connection pool/i.test(e.message);

  async function attemptHold(i: number) {
    for (let tries = 0; tries < 4; tries++) {
      try {
        await new Promise((r) => setTimeout(r, Math.random() * 1200));
        return await createBookingHold({
          propertyId,
          roomTypeId: targetRoomType,
          checkIn: drillCheckIn,
          checkOut: drillCheckOut,
          adults: 1,
          children: 0,
          guestName: `Stress Runner ${i + 1}`,
          guestPhone: "0000000000",
          idempotencyKey: `${runId}-${i + 1}`,
          tag: "stress-test",
        });
      } catch (e) {
        if (isDbTimeout(e) && tries < 3) {
          await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  // Truly parallel: N independent hold requests racing on the same nights.
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_, i) => attemptHold(i))
  );

  let granted = 0;
  let soldOut = 0;
  const errors: string[] = [];
  const rejectionDetails: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      granted++;
    } else if (r.reason instanceof SoldOutError) {
      soldOut++;
      rejectionDetails.push(r.reason.message);
    } else {
      errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }

  // Every rejected drill attempt is a real oversale-blocked event — record it
  // so the "Oversales blocked" counter and the activity log stay truthful.
  await Promise.all(
    rejectionDetails.slice(0, 30).map((msg) =>
      logActivity({
        propertyId,
        staffId: auth.session.sub,
        staffName: auth.session.name,
        action: "BOOKING_REJECTED",
        entity: "RoomType",
        entityId: body.roomTypeId,
        details: `Oversale guard rejected a parallel-booking attempt — ${msg}`,
      })
    )
  );

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GUARD_STRESS_TEST",
    entity: "BookingHold",
    details: `Oversale guard drill — ${attempts} parallel hold attempts on ${body.roomTypeId.slice(-6)} for ${checkIn.toISOString().slice(0, 10)}: ${granted} granted, ${soldOut} rejected, ${errors.length} errors`,
  });

  return NextResponse.json({
    ok: true,
    attempts,
    granted,
    soldOut,
    errors: errors.slice(0, 5),
    note:
      "Every granted hold reserved one room of inventory for 10 minutes; the rest were rejected by the write-locked availability check instead of double-selling. Clean up the stress holds to restore the inventory.",
  });
}
