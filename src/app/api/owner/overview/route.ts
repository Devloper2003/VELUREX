import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { cyclePrice } from "@/lib/platform";
import { demoScope, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";

/**
 * GET /api/owner/overview — Software Owner dashboard:
 * headline stats, revenue trend, plan mix, alerts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalBusinesses,
    activeSubs,
    trialSubs,
    suspendedSubs,
    overdueSubs,
    plans,
    subsWithPlan,
    paidPayments,
    newThisMonth,
    expiringSoon,
    openTickets,
    urgentTickets,
    failedSyncs,
    pendingChannels,
  ] = await Promise.all([
    db.property.count({ where: { deletedAt: null, ...notDemoTenantId(scope) } }),
    db.subscription.count({ where: { status: "active", ...notDemoTenant(scope) } }),
    db.subscription.count({ where: { status: "trial", ...notDemoTenant(scope) } }),
    db.subscription.count({ where: { status: "suspended", ...notDemoTenant(scope) } }),
    db.subscription.count({ where: { status: "overdue", ...notDemoTenant(scope) } }),
    db.plan.findMany({ orderBy: { sortOrder: "asc" } }),
    db.subscription.findMany({ where: notDemoTenant(scope), include: { plan: true, property: { select: { name: true, deletedAt: true } } } }),
    db.platformPayment.findMany({ where: { status: "success", kind: "payment", ...notDemoTenant(scope) } }),
    db.property.count({ where: { deletedAt: null, createdAt: { gte: monthStart }, ...notDemoTenantId(scope) } }),
    db.subscription.findMany({
      where: { status: "active", renewalAt: { lte: new Date(now.getTime() + 7 * 86400000) }, ...notDemoTenant(scope) },
      include: { property: { select: { name: true } }, plan: { select: { name: true } } },
      orderBy: { renewalAt: "asc" },
      take: 10,
    }),
    db.supportTicket.count({ where: { status: { in: ["open", "in_progress", "waiting"] }, ...notDemoTenant(scope) } }),
    db.supportTicket.count({ where: { status: { in: ["open", "in_progress", "waiting"] }, priority: "urgent", ...notDemoTenant(scope) } }),
    db.channelSyncLog.count({ where: { status: "failed", attemptedAt: { gte: new Date(now.getTime() - 7 * 86400000) }, ...notDemoTenant(scope) } }),
    db.channelSyncJob.count({ where: { status: "pending", ...notDemoTenant(scope) } }),
  ]);

  // MRR: monthly-equivalent of active subscriptions (cycle discounts) + recurring add-ons
  let mrr = 0;
  for (const s of subsWithPlan) {
    if (s.status === "active" && !s.property?.deletedAt) {
      mrr += await cyclePrice(s.plan.monthlyPrice, s.cycle) / (s.cycle === "yearly" ? 12 : s.cycle === "quarterly" ? 3 : 1);
    }
  }
  const recurringAddons = await db.subscriptionAddon.findMany({ where: { active: true, oneOff: false, ...notDemoTenant(scope) } });
  mrr += recurringAddons.reduce((sum, a) => sum + a.price, 0);
  mrr = Math.round(mrr);

  const revenueTrend: { month: string; revenue: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const rev = paidPayments
      .filter((p) => p.createdAt >= start && p.createdAt < end)
      .reduce((s, p) => s + p.amount, 0);
    revenueTrend.push({
      month: start.toLocaleString("en-IN", { month: "short" }),
      revenue: Math.round(rev),
    });
  }

  const planMix = plans.map((p) => ({
    code: p.code,
    name: p.name,
    price: p.monthlyPrice,
    count: subsWithPlan.filter((s) => s.planId === p.id && ["active", "trial", "overdue"].includes(s.status)).length,
  }));

  const alerts: { kind: string; severity: "info" | "warn" | "danger"; text: string }[] = [];
  for (const s of expiringSoon) {
    const days = s.renewalAt ? Math.ceil((s.renewalAt.getTime() - now.getTime()) / 86400000) : 0;
    alerts.push({ kind: "renewal", severity: days <= 2 ? "warn" : "info", text: `${s.property?.name} — ${s.plan.name} renews in ${days}d` });
  }
  if (overdueSubs > 0) alerts.push({ kind: "overdue", severity: "danger", text: `${overdueSubs} subscription${overdueSubs === 1 ? "" : "s"} overdue on payment` });
  if (failedSyncs > 0) alerts.push({ kind: "ota", severity: "warn", text: `${failedSyncs} OTA sync failures in the last 7 days` });
  if (urgentTickets > 0) alerts.push({ kind: "ticket", severity: "danger", text: `${urgentTickets} urgent support ticket${urgentTickets === 1 ? "" : "s"} waiting` });
  if (pendingChannels > 0) alerts.push({ kind: "queue", severity: "info", text: `${pendingChannels} channel sync jobs pending` });

  return NextResponse.json({
    stats: {
      totalBusinesses, active: activeSubs, trial: trialSubs, suspended: suspendedSubs,
      overdue: overdueSubs, mrr, arr: mrr * 12, newThisMonth,
    },
    revenueTrend,
    planMix,
    alerts: alerts.slice(0, 10),
    openTickets,
  });
}
