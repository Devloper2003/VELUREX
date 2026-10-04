import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { startOfDay, endOfDay } from "@/lib/business";
import { buildSummary, dayKey, parseDayParam } from "../../reports/_shared";

/**
 * GET /api/growth/overview — tenant-side Growth & Revenue payload.
 *
 * Everything is scoped to the session property. Daily rows/totals/channel mix/
 * payments/comparison are reused from the shared reports engine (buildSummary);
 * guest segments, booking funnel and the 7-day forecast are computed here.
 *
 * Params: ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Default window: last 30 days ending on the property business date.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Statuses that count as a "stay" for guest-centric metrics (bookings included). */
const STAY_STATUSES = ["confirmed", "checked_in", "checked_out"];
/** Sources the hotel owns outright — the "direct" side of the channel mix. */
const DIRECT_SOURCES = new Set(["front_desk", "booking_engine", "walk_in"]);
/** VIP threshold — lifetime spend (Σ non-cancelled reservation totals) in INR. */
const VIP_THRESHOLD = 50000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const sp = req.nextUrl.searchParams;
  const fromP = sp.get("from");
  const toP = sp.get("to");
  if ((fromP && !DATE_RE.test(fromP)) || (toP && !DATE_RE.test(toP))) {
    return NextResponse.json({ error: "Invalid date range — expected YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const property = await db.property.findUnique({
      where: { id: propertyId },
      select: { businessDate: true },
    });

    // Default: last 30 days ending on the property business date (rolled by night audit).
    const biz = startOfDay(property?.businessDate ?? new Date());
    const to = startOfDay(parseDayParam(toP) ?? biz);
    const from = startOfDay(parseDayParam(fromP) ?? new Date(to.getTime() - 29 * 86400000));
    if (from.getTime() > to.getTime()) {
      return NextResponse.json({ error: "Range start must be on or before range end" }, { status: 400 });
    }

    const fromISO = dayKey(from);
    const toISO = dayKey(to);
    const fromStart = startOfDay(from);
    const toEnd = endOfDay(to);

    // The weekday-index forecast needs same-weekday samples up to 28 days back
    // from the range end. When the selected window already covers that span the
    // main summary rows are reused (no extra query).
    const rangeCoversForecast = from.getTime() <= to.getTime() - 27 * 86400000;
    const forecastFromISO = dayKey(new Date(to.getTime() - 27 * 86400000));

    const [
      summary,
      lookback,
      holdsByStatus,
      holdPromoRows,
      overlapRes,
      createdRes,
      campaignAgg,
      activeCampaignCount,
      promoCodes,
      lastStayAll,
    ] = await Promise.all([
      // Daily rows + totals + channelMix + topGuests + payments + prev-period comparison
      buildSummary(propertyId, fromISO, toISO),
      rangeCoversForecast ? null : buildSummary(propertyId, forecastFromISO, toISO, { comparison: false }),
      // Booking funnel — holds created in the window, grouped by status
      db.bookingHold.groupBy({
        by: ["status"],
        where: { propertyId, createdAt: { gte: fromStart, lte: toEnd } },
        _count: { _all: true },
      }),
      // Distinct promo codes used on holds in the window
      db.bookingHold.findMany({
        where: { propertyId, createdAt: { gte: fromStart, lte: toEnd }, promoCode: { not: "" } },
        select: { promoCode: true },
        distinct: ["promoCode"],
      }),
      // Stays overlapping the window (guest-centric metrics)
      db.reservation.findMany({
        where: { propertyId, status: { in: STAY_STATUSES }, checkIn: { lte: toEnd }, checkOut: { gt: fromStart } },
        select: { guestId: true, checkIn: true, totalAmount: true },
      }),
      // Bookings created in the window (funnel tail + promo/upsell usage)
      db.reservation.findMany({
        where: { propertyId, createdAt: { gte: fromStart, lte: toEnd } },
        select: { source: true, upsellAmount: true, promoCode: true },
      }),
      // Marketing campaign aggregates
      db.marketingCampaign.aggregate({
        where: { propertyId },
        _sum: { budget: true, spent: true, revenue: true },
        _count: { _all: true },
      }),
      db.marketingCampaign.count({ where: { propertyId, status: "active" } }),
      // Top promo codes for the campaign form + usage stats
      db.promoCode.findMany({
        where: { propertyId },
        orderBy: { usedCount: "desc" },
        take: 10,
        select: { code: true, discountType: true, discountValue: true, usedCount: true, maxUses: true, active: true },
      }),
      // Whole-guest-base last-stay map — powers the lapsed (win-back) audience
      db.reservation.groupBy({
        by: ["guestId"],
        where: { propertyId, status: { in: STAY_STATUSES } },
        _max: { checkIn: true },
      }),
    ]);

    // ── Guest segmentation (needs the overlap guest ids first) ────────────
    const overlapGuestIds = [...new Set(overlapRes.map((r) => r.guestId))];
    const [priorStays, lifetimeSpend] = await Promise.all([
      // Guests with ≥1 stay that started BEFORE the window → "repeat" flag
      db.reservation.groupBy({
        by: ["guestId"],
        where: { propertyId, guestId: { in: overlapGuestIds }, checkIn: { lt: fromStart }, status: { in: STAY_STATUSES } },
        _count: { _all: true },
      }),
      // Lifetime spend = Σ non-cancelled reservation totals (VIP classification)
      db.reservation.groupBy({
        by: ["guestId"],
        where: { propertyId, guestId: { in: overlapGuestIds }, status: { notIn: ["cancelled", "no_show"] } },
        _sum: { totalAmount: true },
      }),
    ]);

    const priorSet = new Set(priorStays.map((p) => p.guestId));
    const lifetimeByGuest = new Map(lifetimeSpend.map((g) => [g.guestId, g._sum.totalAmount ?? 0]));
    const lastStayByGuest = new Map(lastStayAll.map((g) => [g.guestId, g._max.checkIn]));
    const lastStayInRangeByGuest = new Map<string, Date>();
    for (const r of overlapRes) {
      const cur = lastStayInRangeByGuest.get(r.guestId);
      if (!cur || r.checkIn > cur) lastStayInRangeByGuest.set(r.guestId, r.checkIn);
    }

    // ── KPIs ──────────────────────────────────────────────────────────────
    const t = summary.totals;
    const uniqueGuests = overlapGuestIds.length;
    const repeatReservations = overlapRes.filter((r) => priorSet.has(r.guestId)).length;
    const totalBookings = summary.channelMix.reduce((s, c) => s + c.bookings, 0);
    const directBookings = summary.channelMix.filter((c) => DIRECT_SOURCES.has(c.source)).reduce((s, c) => s + c.bookings, 0);

    const kpis = {
      totalRevenue: t.revenue,
      roomRevenue: t.room,
      fnbRevenue: t.fnb,
      miscRevenue: t.misc,
      adr: t.avgAdr,
      revpar: t.avgRevpar,
      occupancyPct: t.avgOccupancy,
      arpu: uniqueGuests > 0 ? round2(t.revenue / uniqueGuests) : 0,
      repeatRatePct: overlapRes.length > 0 ? round1((repeatReservations / overlapRes.length) * 100) : 0,
      directPct: totalBookings > 0 ? round1((directBookings / totalBookings) * 100) : 0,
      uniqueGuests,
      totalBookings,
      directBookings,
    };

    // ── Daily trend ───────────────────────────────────────────────────────
    const trend = summary.rows.map((r) => ({
      date: r.date,
      total: r.totalRevenue,
      room: r.roomRevenue,
      fnb: r.fnbRevenue,
      misc: r.miscRevenue,
    }));

    // ── 7-day forecast — moving average × weekday index ──────────────────
    const forecastRows = (lookback ?? summary).rows;
    const dailyTotals = new Map<string, number>();
    for (const r of forecastRows) dailyTotals.set(r.date, r.totalRevenue);
    const last7 = forecastRows.slice(-7).map((r) => r.totalRevenue);
    const ma7 = last7.length > 0 ? last7.reduce((s, v) => s + v, 0) / last7.length : 0;

    const forecastDays: { date: string; projected: number }[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(to.getTime() + i * 86400000);
      // Same-weekday samples over the past 4 weeks (when the data covers them)
      const samples: number[] = [];
      for (let w = 1; w <= 4; w++) {
        const key = dayKey(new Date(d.getTime() - w * 7 * 86400000));
        const v = dailyTotals.get(key);
        if (v !== undefined) samples.push(v);
      }
      let factor = 0; // no same-weekday history → flat moving average
      if (samples.length > 0 && ma7 > 0) {
        const weekdayAvg = samples.reduce((s, v) => s + v, 0) / samples.length;
        factor = Math.max(-0.9, Math.min(2, weekdayAvg / ma7 - 1));
      }
      forecastDays.push({ date: dayKey(d), projected: round2(ma7 * (1 + factor)) });
    }
    const forecast = {
      method: "moving_average" as const,
      basis:
        "7-day moving average of daily revenue × weekday index (average of the same weekday over the past 4 weeks when available, otherwise the flat 7-day average). Estimate only.",
      days: forecastDays,
    };

    // ── Booking funnel ────────────────────────────────────────────────────
    const holds = holdsByStatus.reduce((s, g) => s + g._count._all, 0);
    const redeemed = holdsByStatus.find((g) => g.status === "redeemed")?._count._all ?? 0;
    const promoSet = new Set<string>();
    for (const h of holdPromoRows) if (h.promoCode) promoSet.add(h.promoCode);
    for (const r of createdRes) if (r.promoCode) promoSet.add(r.promoCode);
    const funnel = {
      holds,
      redeemed,
      promosUsed: promoSet.size,
      upsellsAttached: createdRes.filter((r) => r.upsellAmount > 0).length,
      paidBookings: createdRes.filter((r) => r.source === "booking_engine").length,
    };

    // ── Guest segments ────────────────────────────────────────────────────
    // new / repeat classify the guests who stayed inside the window;
    // vip overlays lifetime spend; lapsed is the property-wide win-back
    // audience (had stays, none in the last 90 days as of today).
    const ninetyAgo = startOfDay(new Date(Date.now() - 90 * 86400000));
    const segments = {
      new: overlapGuestIds.filter((id) => !priorSet.has(id)).length,
      repeat: overlapGuestIds.filter((id) => priorSet.has(id)).length,
      vip: overlapGuestIds.filter((id) => (lifetimeByGuest.get(id) ?? 0) >= VIP_THRESHOLD).length,
      lapsed: lastStayAll.filter((g) => g._max.checkIn && g._max.checkIn < ninetyAgo).length,
      vipThreshold: VIP_THRESHOLD,
      topSpenders: summary.topGuests.map((g) => ({
        guestId: g.guestId,
        name: g.name,
        stays: g.stays,
        spend: g.spend,
        lastStay: lastStayInRangeByGuest.get(g.guestId) ?? lastStayByGuest.get(g.guestId) ?? null,
      })),
    };

    // ── Marketing summary ─────────────────────────────────────────────────
    const totalSpent = round2(campaignAgg._sum.spent ?? 0);
    const attributedRevenue = round2(campaignAgg._sum.revenue ?? 0);
    const marketing = {
      activeCampaigns: activeCampaignCount,
      totalCampaigns: campaignAgg._count._all ?? 0,
      totalBudget: round2(campaignAgg._sum.budget ?? 0),
      totalSpent,
      attributedRevenue,
      avgRoiPct: totalSpent > 0 ? round1((attributedRevenue / totalSpent) * 100) : 0,
      promoCodes,
    };

    return NextResponse.json({
      from: fromISO,
      to: toISO,
      kpis,
      trend,
      forecast,
      funnel,
      segments,
      channelMix: summary.channelMix,
      marketing,
      payments: t.payments,
      comparison: summary.comparison,
    });
  } catch (e) {
    console.error("[growth/overview]", e);
    return NextResponse.json({ error: "Could not build growth overview" }, { status: 500 });
  }
}
