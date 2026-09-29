import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { cyclePrice } from "@/lib/platform";
import { demoScope, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";

/**
 * GET /api/owner/analytics — growth & usage analytics:
 * MRR trend, churn, ARPU, LTV, trial→paid conversion, module usage, geo split.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const now = new Date();
  const [subs, cancelled, plans, payments, usage, tenants] = await Promise.all([
    db.subscription.findMany({ where: notDemoTenant(scope), include: { plan: true, property: { select: { id: true, city: true, state: true, deletedAt: true } } } }),
    db.subscription.findMany({ where: { status: "cancelled", ...notDemoTenant(scope) } }),
    db.plan.findMany({ orderBy: { sortOrder: "asc" } }),
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
  });
}

function cyclePriceLite(monthly: number, cycle: string): number {
  if (cycle === "yearly") return monthly * 12 * 0.9;
  if (cycle === "quarterly") return monthly * 3 * 0.95;
  return monthly;
}
