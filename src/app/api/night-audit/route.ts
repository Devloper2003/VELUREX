import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity, startOfDay, endOfDay } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";
import { runPreArrivalCampaign } from "@/lib/whatsapp";
import { getTenantEntitlements, requireFeature, assertWritable } from "@/lib/entitlements";

/**
 * Task 4-a — Night Audit: the one-click end-of-day close.
 *
 * GET  /api/night-audit → current business date, last audit, history (30), run preview
 * POST /api/night-audit → run the audit (roles: hotel_admin, front_desk)
 *   1. no-show flagging (confirmed/hold with arrival before the business date)
 *   2. room charges for in-house stays covering the business date (idempotent)
 *   3. lock all folio items of the closing date (revenue lock)
 *   4. daily revenue report (rooms / F&B / misc, occupancy, ADR, RevPAR, outstanding)
 *   5. roll the property business date forward one day
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct1 = (n: number) => Math.round(n * 10) / 10;
const DAY_MS = 86400000;

/** Shared revenue aggregation — discounts are stored negative; |discount| always reduces misc. */
function summarizeRevenue(items: { category: string; amount: number }[]) {
  let room = 0, fnb = 0, misc = 0, discount = 0;
  for (const i of items) {
    if (i.category === "room") room += i.amount;
    else if (i.category === "fnb" || i.category === "bar") fnb += i.amount;
    else if (i.category === "laundry" || i.category === "misc" || i.category === "no_show") misc += i.amount;
    else if (i.category === "discount") discount += i.amount;
  }
  misc -= Math.abs(round2(discount));
  return { room: round2(room), fnb: round2(fnb), misc: round2(misc), total: round2(room + fnb + misc) };
}

/** Reservations whose arrival date has passed without a check-in → no-show candidates. */
function noShowCandidates(propertyId: string, before: Date) {
  return db.reservation.findMany({
    where: { propertyId, status: { in: ["confirmed", "hold"] }, checkIn: { lt: before } },
    include: { guest: { select: { fullName: true } }, room: { select: { number: true } } },
    orderBy: { checkIn: "asc" },
  });
}

/** Checked-in stays that cover the business date (checkIn ≤ day end AND checkOut > day start). */
function roomChargeCandidates(propertyId: string, dayStart: Date, dayEnd: Date) {
  return db.reservation.findMany({
    where: {
      propertyId,
      status: "checked_in",
      checkIn: { lte: dayEnd },
      checkOut: { gt: dayStart },
    },
    include: { room: { select: { number: true, roomType: { select: { name: true } } } } },
    orderBy: { checkIn: "asc" },
  });
}

// ─── GET /api/night-audit ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const bd = property.businessDate;
  const dayStart = startOfDay(bd);
  const dayEnd = endOfDay(bd);

  const [history, candidates, arrivalsToday, inHouse, occupiedRooms, totalRooms, dayItems, inHouseStays, existingRoomCharges] =
    await Promise.all([
      db.nightAuditLog.findMany({
        where: { propertyId },
        orderBy: [{ businessDate: "desc" }, { runAt: "desc" }],
        take: 30,
      }),
      noShowCandidates(propertyId, dayStart),
      db.reservation.count({
        where: { propertyId, status: { in: ["confirmed", "hold"] }, checkIn: { gte: dayStart, lte: dayEnd } },
      }),
      db.reservation.count({ where: { propertyId, status: "checked_in" } }),
      db.room.count({ where: { propertyId, status: "occupied" } }),
      db.room.count({ where: { propertyId } }),
      db.folioItem.findMany({ where: { propertyId, businessDate: { gte: dayStart, lte: dayEnd } } }),
      roomChargeCandidates(propertyId, dayStart, dayEnd),
      db.folioItem.findMany({
        where: { propertyId, category: "room", businessDate: { gte: dayStart, lte: dayEnd } },
        select: { reservationId: true },
      }),
    ]);

  const alreadyCharged = new Set(existingRoomCharges.map((i) => i.reservationId));
  const lastAudit = history[0] ?? null;
  const daysOpen = lastAudit
    ? Math.max(0, Math.round((dayStart.getTime() - startOfDay(lastAudit.businessDate).getTime()) / DAY_MS))
    : null;

  return NextResponse.json({
    businessDate: bd,
    property: { name: property.name, noShowPercent: property.noShowPercent },
    lastAudit,
    history,
    preview: {
      noShowCandidates: candidates.map((c) => ({
        id: c.id,
        confirmationNumber: c.confirmationNumber,
        guestName: c.guest.fullName,
        roomNumber: c.room?.number ?? "—",
        checkIn: c.checkIn,
        nights: c.nights,
        nightlyRate: c.nightlyRate,
        firstNightCharge: round2((c.nightlyRate * property.noShowPercent) / 100),
      })),
      arrivalsToday,
      inHouse,
      occupancyNow: pct1(totalRooms ? (occupiedRooms / totalRooms) * 100 : 0),
      occupiedRooms,
      totalRooms,
      revenueToday: summarizeRevenue(dayItems),
      estRoomChargesToPost: inHouseStays.filter((r) => !alreadyCharged.has(r.id)).length,
      daysOpen,
    },
  });
}

// ─── POST /api/night-audit — run the end-of-day close ───────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const session = auth.session;

  // Plan enforcement: night audit is a Pro+ feature; workspace must be writable.
  const ent = await getTenantEntitlements(propertyId);
  const locked = requireFeature(ent, "night_audit", "Night Audit");
  if (locked) return locked;
  const ro = assertWritable(ent);
  if (ro) return ro;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const userNotes = typeof body?.notes === "string" ? body.notes.trim() : "";

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const closingDate = startOfDay(property.businessDate);
  const dayEnd = endOfDay(closingDate);
  const nextBusinessDate = new Date(closingDate);
  nextBusinessDate.setDate(nextBusinessDate.getDate() + 1);
  const noShowPercent = property.noShowPercent;

  // Idempotency guard — one audit per business date
  const existingLog = await db.nightAuditLog.findFirst({
    where: { propertyId, businessDate: { gte: closingDate, lte: dayEnd } },
    select: { id: true },
  });
  if (existingLog) {
    return NextResponse.json({ error: "Night audit already run for this business date" }, { status: 409 });
  }

  const runAt = new Date();

  const [noShowRes, inHouseStays, dayItemsBefore, occupiedRooms, totalRooms, posOrdersBefore] = await Promise.all([
    noShowCandidates(propertyId, closingDate),
    roomChargeCandidates(propertyId, closingDate, dayEnd),
    db.folioItem.findMany({ where: { propertyId, businessDate: { gte: closingDate, lte: dayEnd } } }),
    db.room.count({ where: { propertyId, status: "occupied" } }),
    db.room.count({ where: { propertyId } }),
    db.posOrder.count({ where: { propertyId, createdAt: { lt: runAt } } }),
  ]);

  // Room-charge idempotency: skip stays that already have a room charge on this business date
  const alreadyCharged = new Set(
    dayItemsBefore.filter((i) => i.category === "room").map((i) => i.reservationId)
  );

  // ── 1. No-show flags + first-night charges ──
  const noShowItemData = noShowRes.map((r) => {
    const firstNight = round2((r.nightlyRate * noShowPercent) / 100);
    return {
      reservationId: r.id,
      guestId: r.guestId,
      description: `No-show charge — ${r.nights} night(s) booked (first night ${noShowPercent}%)`,
      amount: firstNight,
    };
  });
  const noShowCharges = round2(noShowItemData.reduce((s, i) => s + i.amount, 0));

  // ── 2. Room charges for in-house stays covering the closing date ──
  const roomChargeItemData = inHouseStays
    .filter((r) => !alreadyCharged.has(r.id))
    .map((r) => ({
      reservationId: r.id,
      guestId: r.guestId,
      description: `Room charge — ${r.room?.number ?? "—"} (${r.room?.roomType?.name ?? "Room"})`,
      amount: round2(r.nightlyRate),
    }));

  // ── Daily revenue report (pre-existing day items + everything posted now) ──
  const revenue = summarizeRevenue([
    ...dayItemsBefore.map((i) => ({ category: i.category, amount: i.amount })),
    ...noShowItemData.map((i) => ({ category: "no_show", amount: i.amount })),
    ...roomChargeItemData.map((i) => ({ category: "room", amount: i.amount })),
  ]);
  const occupancyPercent = pct1(totalRooms ? (occupiedRooms / totalRooms) * 100 : 0);
  const adr = occupiedRooms > 0 ? round2(revenue.room / occupiedRooms) : 0;
  const revpar = totalRooms > 0 ? round2(revenue.room / totalRooms) : 0;

  let lockedItems = 0;
  const log = await db.$transaction(async (tx) => {
    // Flag no-shows and post their folio charges
    for (let i = 0; i < noShowRes.length; i++) {
      await tx.reservation.update({ where: { id: noShowRes[i].id }, data: { status: "no_show" } });
      await tx.folioItem.create({
        data: {
          propertyId,
          reservationId: noShowItemData[i].reservationId,
          guestId: noShowItemData[i].guestId,
          category: "no_show",
          description: noShowItemData[i].description,
          qty: 1,
          rate: noShowItemData[i].amount,
          amount: noShowItemData[i].amount,
          businessDate: closingDate,
          postedBy: session.name,
        },
      });
    }

    // Post room charges
    for (const item of roomChargeItemData) {
      await tx.folioItem.create({
        data: {
          propertyId,
          reservationId: item.reservationId,
          guestId: item.guestId,
          category: "room",
          description: item.description,
          qty: 1,
          rate: item.amount,
          amount: item.amount,
          businessDate: closingDate,
          postedBy: session.name,
        },
      });
    }

    // ── 3. Revenue lock: everything on the closing business date becomes immutable ──
    const lockResult = await tx.folioItem.updateMany({
      where: { propertyId, businessDate: { gte: closingDate, lte: dayEnd }, locked: false },
      data: { locked: true },
    });
    lockedItems = lockResult.count;

    // ── Outstanding balance over active folios (checked_in + checked_out), grouped sums ──
    const activeRes = await tx.reservation.findMany({
      where: { propertyId, status: { in: ["checked_in", "checked_out"] } },
      select: { id: true, paidAmount: true },
    });
    const sums = activeRes.length
      ? await tx.folioItem.groupBy({
          by: ["reservationId"],
          where: { propertyId, reservationId: { in: activeRes.map((r) => r.id) } },
          _sum: { amount: true },
        })
      : [];
    const chargesByRes = new Map(sums.map((s) => [s.reservationId, s._sum.amount ?? 0]));
    const outstandingBalance = round2(
      activeRes.reduce((s, r) => s + (chargesByRes.get(r.id) ?? 0) - r.paidAmount, 0)
    );

    const notes = [
      userNotes,
      `Transactions locked: ${lockedItems} folio item(s) · ${posOrdersBefore} POS order(s) pre-cutoff marked lockable`,
    ]
      .filter(Boolean)
      .join(" — ");

    // ── 4. Daily report log ──
    return tx.nightAuditLog.create({
      data: {
        propertyId,
        businessDate: closingDate,
        runBy: session.sub,
        runByName: session.name,
        runAt,
        totalRevenue: revenue.total,
        roomRevenue: revenue.room,
        fnbRevenue: revenue.fnb,
        miscRevenue: revenue.misc,
        occupancyPercent,
        adr,
        revpar,
        occupiedRooms,
        totalRooms,
        noShowCount: noShowRes.length,
        noShowCharges,
        outstandingBalance,
        notes,
      },
    });
  });

  // ── 5. Roll the business date forward ──
  await db.property.update({ where: { id: propertyId }, data: { businessDate: nextBusinessDate } });

  // ── 6. Auto pre-arrival WhatsApp campaign for tomorrow's arrivals ──
  // Idempotent (guests already messaged are skipped) and best-effort — a
  // messaging outage must never fail the night audit.
  let preArrival: Awaited<ReturnType<typeof runPreArrivalCampaign>> | null = null;
  try {
    preArrival = await runPreArrivalCampaign(propertyId, nextBusinessDate);
  } catch {
    /* messaging is optional — keep the audit result intact */
  }

  await logActivity({
    propertyId,
    staffId: session.sub,
    staffName: session.name,
    action: "NIGHT_AUDIT",
    entity: "NightAuditLog",
    entityId: log.id,
    details: `Business date closed — revenue ₹${log.totalRevenue.toFixed(2)} · occupancy ${log.occupancyPercent}% · ADR ₹${log.adr.toFixed(2)} · no-shows ${log.noShowCount} (₹${log.noShowCharges.toFixed(2)}) · ${roomChargeItemData.length} room charges posted · ${lockedItems} items locked${preArrival ? ` · pre-arrival WhatsApp ×${preArrival.sent}` : ""} · next business date ${nextBusinessDate.toDateString()}`,
  });

  // Live-push: every open client gets a toast/refresh trigger (best-effort).
  emitRealtime("global", "night-audit:done", {
    businessDate: log.businessDate,
    totalRevenue: log.totalRevenue,
    occupancyPercent: log.occupancyPercent,
    adr: log.adr,
    noShowCount: log.noShowCount,
  });

  return NextResponse.json(
    {
      log,
      breakdown: {
        noShowReservations: noShowRes.map((r, i) => ({
          confirmationNumber: r.confirmationNumber,
          guestName: r.guest.fullName,
          charge: noShowItemData[i]?.amount ?? 0,
        })),
        roomChargesPosted: roomChargeItemData.length,
        lockedItems,
        preArrivalCampaign: preArrival,
      },
    },
    { status: 201 }
  );
}
