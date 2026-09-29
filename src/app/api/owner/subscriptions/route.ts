import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/subscriptions — all subscriptions with plan + property, usage
 * counts and pending invoices. Filter: ?status=&plan=&cycle=&search=
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "";
  const plan = sp.get("plan") ?? "";
  const search = sp.get("search")?.trim() ?? "";

  const where: Record<string, unknown> = { ...notDemoTenant(scope) };
  if (status) where.status = status;
  if (plan) where.planId = plan;
  if (search) {
    where.property = { name: { contains: search, mode: "insensitive" } };
  }

  const subs = await db.subscription.findMany({
    where,
    include: {
      plan: true,
      property: {
        include: {
          _count: { select: { rooms: true, staff: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const pendingInv = await db.invoice.findMany({
    where: { status: { in: ["pending", "overdue"] }, ...notDemoTenant(scope) },
    select: { propertyId: true, totalAmount: true, status: true, number: true },
  });
  const pendingMap = new Map<string, { total: number; numbers: string[] }>();
  for (const inv of pendingInv) {
    const cur = pendingMap.get(inv.propertyId) ?? { total: 0, numbers: [] };
    cur.total += inv.totalAmount;
    cur.numbers.push(inv.number);
    pendingMap.set(inv.propertyId, cur);
  }

  const rows = subs
    .filter((s) => !s.property.deletedAt || status === "cancelled")
    .map((s) => ({
      id: s.id,
      property: { id: s.property.id, name: s.property.name, city: s.property.city },
      plan: { id: s.plan.id, code: s.plan.code, name: s.plan.name, monthlyPrice: s.plan.monthlyPrice },
      cycle: s.cycle,
      status: s.status,
      startedAt: s.startedAt,
      renewalAt: s.renewalAt,
      trialEndsAt: s.trialEndsAt,
      autoRenew: s.autoRenew,
      pendingPlanId: s.pendingPlanId,
      usage: { rooms: s.property._count.rooms, staff: s.property._count.staff },
      pending: pendingMap.get(s.property.id) ?? null,
    }));

  return NextResponse.json({ subscriptions: rows, total: rows.length });
}
