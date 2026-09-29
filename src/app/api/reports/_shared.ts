import { db } from "@/lib/db";
import { startOfDay, endOfDay } from "@/lib/business";

/**
 * Shared report computation used by /api/reports/summary and /api/reports/export.
 *
 * Daily rows prefer NightAuditLog (source: "audit"); for business dates without an
 * audit log the numbers are computed from FolioItems + Reservation stay overlap
 * (source: "computed").
 */

export interface ReportRow {
  date: string; // yyyy-mm-dd
  occupancyPercent: number;
  adr: number;
  revpar: number;
  roomRevenue: number;
  fnbRevenue: number;
  miscRevenue: number;
  totalRevenue: number;
  noShowCount: number;
  outstandingBalance: number;
  occupiedRooms: number;
  totalRooms: number;
  source: "audit" | "computed";
}

export interface TopGuest {
  guestId: string;
  name: string;
  stays: number;
  spend: number;
}

export interface ChannelMixEntry {
  source: string; // front_desk | booking_engine | walk_in | ota | phone
  bookings: number;
  nights: number; // stay-overlap nights inside the range
  roomRevenue: number; // overlapped nights × nightly rate
  adr: number; // roomRevenue / nights
}

export interface ReportTotals {
  revenue: number;
  room: number;
  fnb: number;
  misc: number;
  avgOccupancy: number;
  avgAdr: number;
  avgRevpar: number;
  noShows: number;
  payments: { cash: number; upi: number; card: number; netbanking: number; razorpay: number };
}

export interface SummaryResult {
  from: string;
  to: string;
  rows: ReportRow[];
  totals: ReportTotals;
  topGuests: TopGuest[];
  channelMix: ChannelMixEntry[];
  /** Same-length previous period + percent deltas — absent when comparison is disabled. */
  comparison?: ComparisonResult;
}

export interface ComparisonResult {
  from: string;
  to: string;
  totals: ReportTotals;
  deltas: ComparisonDeltas;
}

/** Percent change current vs previous; null when the previous period has no baseline. */
export interface ComparisonDeltas {
  revenue: number | null;
  room: number | null;
  fnb: number | null;
  misc: number | null;
  avgOccupancy: number | null;
  avgAdr: number | null;
  avgRevpar: number | null;
  noShows: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse a yyyy-mm-dd param into a local day-start Date, or null when absent/invalid. */
export function parseDayParam(v: string | null | undefined): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const cur = startOfDay(from);
  const last = startOfDay(to);
  while (cur.getTime() <= last.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Category → revenue bucket mapping (consistent with dashboard revenue mix). */
export function revenueBucket(category: string): "room" | "fnb" | "misc" | "exclude" {
  if (category === "room") return "room";
  if (category === "fnb" || category === "bar") return "fnb";
  if (category === "laundry" || category === "misc" || category === "no_show" || category === "discount") return "misc";
  return "exclude"; // tax & unknowns are pass-through, not revenue
}

export async function buildSummary(
  propertyId: string,
  fromISO: string,
  toISO: string,
  opts: { comparison?: boolean } = {}
): Promise<SummaryResult> {
  const { comparison = true } = opts;
  const from = startOfDay(parseDayParam(fromISO) ?? new Date(Date.now() - 13 * 86400000));
  const to = endOfDay(parseDayParam(toISO) ?? new Date());
  if (from.getTime() > to.getTime()) {
    // tolerate inverted ranges by swapping
    const f = startOfDay(new Date(to));
    const t = endOfDay(new Date(from));
    from.setTime(f.getTime());
    to.setTime(t.getTime());
  }

  const core = await computeSummary(propertyId, from, to);

  if (!comparison) return core;

  // ── Previous period of the SAME length, ending the day before `from` ──────
  const rangeDays = Math.max(1, Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000) + 1);
  const prevTo = new Date(startOfDay(from).getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (rangeDays - 1) * 86400000);
  const prev = await computeSummary(propertyId, prevFrom, endOfDay(prevTo));

  return {
    ...core,
    comparison: {
      from: dayKey(prevFrom),
      to: dayKey(prevTo),
      totals: prev.totals,
      deltas: {
        revenue: pctDelta(core.totals.revenue, prev.totals.revenue),
        room: pctDelta(core.totals.room, prev.totals.room),
        fnb: pctDelta(core.totals.fnb, prev.totals.fnb),
        misc: pctDelta(core.totals.misc, prev.totals.misc),
        avgOccupancy: pctDelta(core.totals.avgOccupancy, prev.totals.avgOccupancy),
        avgAdr: pctDelta(core.totals.avgAdr, prev.totals.avgAdr),
        avgRevpar: pctDelta(core.totals.avgRevpar, prev.totals.avgRevpar),
        noShows: pctDelta(core.totals.noShows, prev.totals.noShows),
      },
    },
  };
}

/** Percent change; null when there is no usable baseline (prev is 0). */
function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

async function computeSummary(propertyId: string, from: Date, to: Date): Promise<SummaryResult> {
  const days = eachDay(from, to);

  const [audits, rooms, folioItems, stayReservations, noShowReservations, payments] = await Promise.all([
    db.nightAuditLog.findMany({
      where: { propertyId, businessDate: { gte: from, lte: to } },
      orderBy: { businessDate: "asc" },
    }),
    db.room.count({ where: { propertyId } }),
    db.folioItem.findMany({
      where: { propertyId, businessDate: { gte: from, lte: to } },
      select: { businessDate: true, category: true, amount: true },
    }),
    db.reservation.findMany({
      where: {
        propertyId,
        status: { in: ["checked_in", "checked_out", "no_show"] },
        checkIn: { lte: to },
        checkOut: { gt: from },
      },
      select: { status: true, checkIn: true, checkOut: true, totalAmount: true, paidAmount: true, source: true, nightlyRate: true },
    }),
    db.reservation.findMany({
      where: { propertyId, status: "no_show", checkIn: { gte: from, lte: to } },
      select: { checkIn: true },
    }),
    db.payment.findMany({
      where: { propertyId, createdAt: { gte: from, lte: to }, status: { in: ["success", "refund"] } },
      select: { method: true, amount: true, status: true },
    }),
  ]);

  const totalRooms = rooms || 1;
  const auditByDay = new Map<string, (typeof audits)[number]>();
  for (const a of audits) auditByDay.set(dayKey(a.businessDate), a);

  // Folio revenue grouped per day per revenue bucket
  const folioByDay = new Map<string, { room: number; fnb: number; misc: number }>();
  for (const item of folioItems) {
    const bucket = revenueBucket(item.category);
    if (bucket === "exclude") continue;
    const key = dayKey(item.businessDate);
    const agg = folioByDay.get(key) ?? { room: 0, fnb: 0, misc: 0 };
    agg[bucket] += item.amount;
    folioByDay.set(key, agg);
  }

  const rows: ReportRow[] = days.map((day) => {
    const key = dayKey(day);
    const audit = auditByDay.get(key);

    if (audit) {
      return {
        date: key,
        occupancyPercent: round1(audit.occupancyPercent),
        adr: round2(audit.adr),
        revpar: round2(audit.revpar),
        roomRevenue: round2(audit.roomRevenue),
        fnbRevenue: round2(audit.fnbRevenue),
        miscRevenue: round2(audit.miscRevenue),
        totalRevenue: round2(audit.totalRevenue),
        noShowCount: audit.noShowCount,
        outstandingBalance: round2(audit.outstandingBalance),
        occupiedRooms: audit.occupiedRooms,
        totalRooms: audit.totalRooms || totalRooms,
        source: "audit" as const,
      };
    }

    // Computed day: folio revenue by category + stay-overlap occupancy estimate
    const agg = folioByDay.get(key) ?? { room: 0, fnb: 0, misc: 0 };
    const dayStart = startOfDay(day);
    let occupied = 0;
    let outstanding = 0;
    for (const r of stayReservations) {
      if (r.status === "no_show") continue;
      if (startOfDay(r.checkIn) <= dayStart && startOfDay(r.checkOut) > dayStart) {
        occupied += 1;
        outstanding += Math.max(0, r.totalAmount - r.paidAmount);
      }
    }
    const noShowCount = noShowReservations.filter(
      (n) => startOfDay(n.checkIn).getTime() === dayStart.getTime()
    ).length;
    const roomRevenue = round2(agg.room);
    const fnbRevenue = round2(agg.fnb);
    const miscRevenue = round2(agg.misc);

    return {
      date: key,
      occupancyPercent: round1((occupied / totalRooms) * 100),
      adr: occupied > 0 ? round2(roomRevenue / occupied) : 0,
      revpar: round2(roomRevenue / totalRooms),
      roomRevenue,
      fnbRevenue,
      miscRevenue,
      totalRevenue: round2(roomRevenue + fnbRevenue + miscRevenue),
      noShowCount,
      outstandingBalance: round2(outstanding),
      occupiedRooms: occupied,
      totalRooms,
      source: "computed" as const,
    };
  });

  // ── Range totals ────────────────────────────────────────────────────────
  const n = rows.length || 1;
  const room = round2(rows.reduce((s, r) => s + r.roomRevenue, 0));
  const fnb = round2(rows.reduce((s, r) => s + r.fnbRevenue, 0));
  const misc = round2(rows.reduce((s, r) => s + r.miscRevenue, 0));

  const paymentTotals = { cash: 0, upi: 0, card: 0, netbanking: 0, razorpay: 0 } as ReportTotals["payments"];
  for (const p of payments) {
    const signed = p.status === "refund" ? -p.amount : p.amount;
    if (p.method in paymentTotals) {
      paymentTotals[p.method as keyof typeof paymentTotals] += signed;
    }
  }
  (Object.keys(paymentTotals) as (keyof typeof paymentTotals)[]).forEach((k) => {
    paymentTotals[k] = round2(paymentTotals[k]);
  });

  const totals: ReportTotals = {
    revenue: round2(room + fnb + misc),
    room,
    fnb,
    misc,
    avgOccupancy: round1(rows.reduce((s, r) => s + r.occupancyPercent, 0) / n),
    avgAdr: round2(rows.reduce((s, r) => s + r.adr, 0) / n),
    avgRevpar: round2(rows.reduce((s, r) => s + r.revpar, 0) / n),
    noShows: rows.reduce((s, r) => s + r.noShowCount, 0),
    payments: paymentTotals,
  };

  const topGuests = await computeTopGuests(propertyId, from, to);

  // ── Channel mix: attribution of room nights across reservation sources.
  // A stay contributes one night per calendar day it is active inside the
  // range (same convention as the occupancy estimate), valued at its nightly
  // rate — so the channel numbers reconcile with room revenue.
  const fromDay = startOfDay(from);
  const toDay = startOfDay(to);
  const channelAgg = new Map<string, { bookings: number; nights: number; roomRevenue: number }>();
  for (const r of stayReservations) {
    if (r.status === "no_show") {
      // no-shows count as a booking attempt for the channel, no nights
      const cur = channelAgg.get(r.source) ?? { bookings: 0, nights: 0, roomRevenue: 0 };
      cur.bookings += 1;
      channelAgg.set(r.source, cur);
      continue;
    }
    const start = startOfDay(r.checkIn);
    const end = startOfDay(r.checkOut);
    // Nights slept are [checkIn, checkOut−1]; clamp both ends to the range.
    const firstNight = start < fromDay ? fromDay : start;
    const lastSlept = new Date(end.getTime() - 86400000);
    const lastNight = lastSlept > toDay ? toDay : lastSlept;
    const nights = Math.max(0, Math.round((lastNight.getTime() - firstNight.getTime()) / 86400000));
    const cur = channelAgg.get(r.source) ?? { bookings: 0, nights: 0, roomRevenue: 0 };
    cur.bookings += 1;
    cur.nights += nights;
    cur.roomRevenue += nights * r.nightlyRate;
    channelAgg.set(r.source, cur);
  }
  const channelMix: ChannelMixEntry[] = [...channelAgg.entries()]
    .map(([source, a]) => ({
      source,
      bookings: a.bookings,
      nights: a.nights,
      roomRevenue: round2(a.roomRevenue),
      adr: a.nights > 0 ? round2(a.roomRevenue / a.nights) : 0,
    }))
    .sort((a, b) => b.roomRevenue - a.roomRevenue);

  return { from: dayKey(from), to: dayKey(to), rows, totals, topGuests, channelMix };
}

/** Top 5 guests by folio spend in the range (guestId, else the reservation's guest). */
async function computeTopGuests(propertyId: string, from: Date, to: Date): Promise<TopGuest[]> {
  const items = await db.folioItem.findMany({
    where: { propertyId, businessDate: { gte: from, lte: to } },
    select: { guestId: true, amount: true, reservation: { select: { guestId: true } } },
  });

  const spend = new Map<string, number>();
  for (const it of items) {
    const gid = it.guestId || it.reservation.guestId;
    if (!gid) continue;
    spend.set(gid, (spend.get(gid) ?? 0) + it.amount);
  }

  const ids = [...spend.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
  if (ids.length === 0) return [];

  const [guests, stays] = await Promise.all([
    db.guest.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }),
    db.reservation.groupBy({
      by: ["guestId"],
      where: {
        propertyId,
        guestId: { in: ids },
        status: { in: ["confirmed", "checked_in", "checked_out"] },
        checkIn: { lte: to },
        checkOut: { gt: from },
      },
      _count: { _all: true },
    }),
  ]);

  const nameById = new Map(guests.map((g) => [g.id, g.fullName]));
  const staysByGuest = new Map(stays.map((s) => [s.guestId, s._count._all]));

  return ids.map((id) => ({
    guestId: id,
    name: nameById.get(id) ?? "Unknown guest",
    stays: staysByGuest.get(id) ?? 0,
    spend: round2(spend.get(id) ?? 0),
  }));
}

/** CSV cell — values as-is, quotes escaped by doubling, always wrapped in quotes. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function csvResponse(body: string, filename: string): Response {
  // \ufeff BOM so Excel opens the file as UTF-8
  return new Response(`\ufeff${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
