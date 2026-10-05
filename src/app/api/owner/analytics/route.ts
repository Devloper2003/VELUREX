import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { PLAN_CORE_SELECT, findPlansSafe } from "@/lib/plan-safe";
import { cyclePrice } from "@/lib/platform";
import { demoScope, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";

/**
 * GET /api/owner/analytics — growth & usage analytics:
 * MRR trend, churn, ARPU, LTV, trial→paid conversion, module usage, geo split
 * + `growth` (Task 35-c): signup/GMV trends, top businesses, plan mix, retention.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const now = new Date();
  const [subs, cancelled, plans, payments, usage, tenants] = await Promise.all([
    db.subscription.findMany({ where: notDemoTenant(scope), include: { plan: { select: PLAN_CORE_SELECT }, property: { select: { id: true, city: true, state: true, deletedAt: true } } } }),
    db.subscription.findMany({ where: { status: "cancelled", ...notDemoTenant(scope) } }),
    findPlansSafe(),
    db.platformPayment.findMany({ where: { kind: "payment", status: "success", ...notDemoTenant(scope) } }),
    db.usageMetric.findMany({ where: notDemoTenant(scope), orderBy: { date: "desc" }, take: 200 }),
    db.property.findMany({ where: { deletedAt: null, ...notDemoTenantId(scope) }, select: { id: true, city: true, state: true } }),
  ]);

  const live = subs.filter((s) => ["active", "trial", "overdue"].includes(s.status) && !s.property?.deletedAt);
  const active = live.filter((s) => s.status === "active");

  // MRR trend over the last 12 months (based on payments collected + current mix as today's value)
  const mrrNow = active.reduce((sum, s) => sum + cyclePriceLite(s.plan.monthlyPrice, s.cycle) / (s.cycle === "yearly" ? 12 : s.cycle === "quarterly" ? 3 : 1), 0)
    + (await db.subscriptionAddon.findMany({ where: { active: true, oneOff: false, ...notDemoTenant(scope) } })).reduce((s, a) => s + a.price, 0);

  const mrrTrend: { month: string; mrr: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    // subscriptions active at some point in that month
    const mrrThatMonth = subs
      .filter((s) => s.property && !s.property.deletedAt && s.startedAt <= monthEnd && (!s.cancelledAt || s.cancelledAt >= monthStart))
      .reduce((sum, s) => sum + cyclePriceLite(s.plan.monthlyPrice, s.cycle) / (s.cycle === "yearly" ? 12 : s.cycle === "quarterly" ? 3 : 1), 0);
    mrrTrend.push({ month: monthStart.toLocaleString("en-IN", { month: "short" }), mrr: Math.round(mrrThatMonth) });
  }

  // Churn: cancelled in last 90d / active at period start (simple monthly rate averaged)
  const ninetyAgo = new Date(now.getTime() - 90 * 86400000);
  const churnedRecently = cancelled.filter((c) => c.cancelledAt && c.cancelledAt >= ninetyAgo).length;
  const churnRate = active.length + churnedRecently > 0
    ? Math.round((churnedRecently / (active.length + churnedRecently)) * 1000) / 10
    : 0;

  const arpu = active.length > 0 ? Math.round(mrrNow / active.length) : 0;
  // LTV ≈ ARPU × average lifetime months (1/churn-rate when churn>0, else conservative 24)
  const lifetimeMonths = churnRate > 0 ? Math.min(36, Math.round(100 / churnRate)) : 24;
  const ltv = arpu * lifetimeMonths;

  // Trial → paid conversion
  const trialsEver = subs.filter((s) => s.trialEndsAt !== null || s.status === "trial").length;
  const converted = subs.filter((s) => ["active", "overdue", "cancelled"].includes(s.status) && s.trialEndsAt).length;
  const trialConversion = trialsEver > 0 ? Math.round((converted / trialsEver) * 100) : 0;

  // Module usage from the latest usage snapshot per tenant
  const latestByTenant = new Map<string, (typeof usage)[number]>();
  for (const u of usage) if (!latestByTenant.has(u.propertyId)) latestByTenant.set(u.propertyId, u);
  const snapshots = [...latestByTenant.values()];
  const moduleUsage = [
    { module: "Booking Engine / Reservations", tenants: snapshots.filter((u) => u.bookings > 0).length },
    { module: "WhatsApp Automation", tenants: snapshots.filter((u) => u.whatsappMsgs > 0).length },
    { module: "Front Desk Active (7d)", tenants: snapshots.filter((u) => u.lastActiveAt && Date.now() - u.lastActiveAt.getTime() < 7 * 86400000).length },
  ];
  const posTenants = await db.posOrder.groupBy({ by: ["propertyId"], where: notDemoTenant(scope), _count: true });
  moduleUsage.push({ module: "Restaurant POS", tenants: posTenants.length });
  const channelTenants = await db.channelConnection.groupBy({ by: ["propertyId"], where: { status: "connected", ...notDemoTenant(scope) }, _count: true });
  moduleUsage.push({ module: "OTA Channels", tenants: channelTenants.length });

  // Geo split (city + state)
  const cityMap = new Map<string, number>();
  const stateMap = new Map<string, number>();
  for (const t of tenants) {
    cityMap.set(t.city || "Unknown", (cityMap.get(t.city || "Unknown") ?? 0) + 1);
    stateMap.set(t.state || "Unknown", (stateMap.get(t.state || "Unknown") ?? 0) + 1);
  }

  // ── Platform growth (Task 35-c) — additive block, existing payload untouched ──
  // Convention: JS map-reduce on date-filtered selects (no raw SQL → zero
  // injection surface). Demo tenants are excluded outright for tenant-economy
  // metrics (signups / GMV / top businesses), matching the spec.
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const last12Keys: string[] = [];
  for (let i = 11; i >= 0; i--) last12Keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const ninetyAgoDate = new Date(now.getTime() - 90 * 86400000);
  const in7d = new Date(now.getTime() + 7 * 86400000);

  const [subInvoices, newProps, gmvRows, top90Rows] = await Promise.all([
    // Billed subscription revenue (pre-tax, net of discounts) for the MRR basis
    db.invoice.findMany({
      where: { type: "subscription", createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 11, 1) }, ...notDemoTenant(scope) },
      select: { subtotal: true, discountAmount: true, createdAt: true, periodStart: true },
    }),
    // New businesses — excludes demo + soft-deleted
    db.property.findMany({
      where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 11, 1) }, isDemo: false, deletedAt: null },
      select: { createdAt: true },
    }),
    // GMV — Σ non-cancelled reservation totals, demo properties excluded
    db.reservation.findMany({
      where: {
        createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 11, 1) },
        status: { notIn: ["cancelled", "no_show"] },
        property: { isDemo: false, deletedAt: null },
      },
      select: { propertyId: true, totalAmount: true, createdAt: true },
    }),
    // Top businesses — last-90-days booked revenue
    db.reservation.findMany({
      where: {
        createdAt: { gte: ninetyAgoDate },
        status: { notIn: ["cancelled", "no_show"] },
        property: { isDemo: false, deletedAt: null },
      },
      select: { propertyId: true, totalAmount: true },
    }),
  ]);

  // MRR trend — prefer actual billed invoices (≥2 months of history); otherwise
  // fall back to active|trial subscription cohorts grouped by start month.
  const invoiceMonthly = new Map<string, number>();
  for (const inv of subInvoices) {
    const key = monthKey(inv.periodStart ?? inv.createdAt);
    invoiceMonthly.set(key, (invoiceMonthly.get(key) ?? 0) + Math.max(0, inv.subtotal - inv.discountAmount));
  }
  const invoiceMonths = last12Keys.filter((k) => (invoiceMonthly.get(k) ?? 0) > 0).length;

  let mrrBasis: string;
  let growthMrrTrend: { month: string; mrr: number }[];
  if (invoiceMonths >= 2) {
    mrrBasis = "invoices — Σ billed subscription invoices per month (pre-tax, net of discounts)";
    growthMrrTrend = last12Keys.map((k) => ({ month: k, mrr: Math.round(invoiceMonthly.get(k) ?? 0) }));
  } else {
    mrrBasis = "subscription_cohorts — Σ plan monthlyPrice of active|trial subscriptions grouped by start month (invoice history too thin)";
    const cohortMonthly = new Map<string, number>();
    for (const s of subs) {
      if (!(s.status === "active" || s.status === "trial") || s.property?.deletedAt) continue;
      const key = monthKey(s.startedAt);
      cohortMonthly.set(key, (cohortMonthly.get(key) ?? 0) + s.plan.monthlyPrice);
    }
    growthMrrTrend = last12Keys.map((k) => ({ month: k, mrr: Math.round(cohortMonthly.get(k) ?? 0) }));
  }

  // Signups — new businesses per month
  const signupMonthly = new Map<string, number>();
  for (const p of newProps) signupMonthly.set(monthKey(p.createdAt), (signupMonthly.get(monthKey(p.createdAt)) ?? 0) + 1);

  // GMV — bookings + booked value per month
  const gmvMonthly = new Map<string, { gmv: number; bookings: number }>();
  for (const r of gmvRows) {
    const key = monthKey(r.createdAt);
    const cur = gmvMonthly.get(key) ?? { gmv: 0, bookings: 0 };
    cur.gmv += r.totalAmount;
    cur.bookings += 1;
    gmvMonthly.set(key, cur);
  }

  // Top 5 businesses by last-90-days booked revenue
  const revenueByProp = new Map<string, { revenue: number; bookings: number }>();
  for (const r of top90Rows) {
    const cur = revenueByProp.get(r.propertyId) ?? { revenue: 0, bookings: 0 };
    cur.revenue += r.totalAmount;
    cur.bookings += 1;
    revenueByProp.set(r.propertyId, cur);
  }
  const top5 = [...revenueByProp.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
  const topProps = top5.length > 0
    ? await db.property.findMany({ where: { id: { in: top5.map(([id]) => id) } }, select: { id: true, name: true, currentPlanId: true } })
    : [];
  const planByPropertyId = new Map(subs.map((s) => [s.propertyId, s.plan]));

  const growth = {
    mrrBasis,
    mrrTrend: growthMrrTrend,
    signupsTrend: last12Keys.map((k) => ({ month: k, count: signupMonthly.get(k) ?? 0 })),
    gmvTrend: last12Keys.map((k) => {
      const agg = gmvMonthly.get(k);
      return { month: k, gmv: Math.round(agg?.gmv ?? 0), bookings: agg?.bookings ?? 0 };
    }),
    topBusinesses: top5.map(([propertyId, agg]) => {
      const prop = topProps.find((p) => p.id === propertyId);
      return {
        propertyId,
        name: prop?.name ?? "Unknown business",
        revenue: Math.round(agg.revenue),
        bookings: agg.bookings,
        plan: planByPropertyId.get(propertyId)?.code ?? plans.find((p) => p.id === prop?.currentPlanId)?.code ?? "—",
      };
    }),
    planMix: plans
      .map((p) => ({ planCode: p.code, count: subs.filter((s) => s.planId === p.id).length }))
      .filter((x) => x.count > 0),
    retention: (() => {
      const liveSubs = subs.filter((s) => !s.property?.deletedAt);
      return {
        active: liveSubs.filter((s) => s.status === "active").length,
        trial: liveSubs.filter((s) => s.status === "trial").length,
        overdue: liveSubs.filter((s) => s.status === "overdue").length,
        suspended: liveSubs.filter((s) => s.status === "suspended").length,
        cancelled: liveSubs.filter((s) => s.status === "cancelled").length,
        trialsExpiring7d: liveSubs.filter((s) => s.status === "trial" && s.trialEndsAt && s.trialEndsAt > now && s.trialEndsAt <= in7d).length,
      };
    })(),
  };

  return NextResponse.json({
    kpis: {
      mrr: Math.round(mrrNow),
      arr: Math.round(mrrNow * 12),
      churnRate,
      arpu,
      ltv,
      lifetimeMonths,
      trialConversion,
      activeCount: active.length,
      cancelledCount: cancelled.length,
    },
    mrrTrend,
    planDistribution: plans.map((p) => ({
      name: p.name, code: p.code, price: p.monthlyPrice,
      count: live.filter((s) => s.planId === p.id).length,
    })),
    moduleUsage,
    citySplit: [...cityMap.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
    stateSplit: [...stateMap.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
    growth,
  });
}

function cyclePriceLite(monthly: number, cycle: string): number {
  if (cycle === "yearly") return monthly * 12 * 0.9;
  if (cycle === "quarterly") return monthly * 3 * 0.95;
  return monthly;
}
