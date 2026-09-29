import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { startOfDay, endOfDay } from "@/lib/business";
import { parseDayParam, dayKey } from "../_shared";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** GET /api/reports/pos?from=&to= — F&B summary for the reports view. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const sp = req.nextUrl.searchParams;
  const fromRaw = sp.get("from") ?? "";
  const toRaw = sp.get("to") ?? "";
  if ((fromRaw && !parseDayParam(fromRaw)) || (toRaw && !parseDayParam(toRaw))) {
    return NextResponse.json({ error: "Invalid date range — expected YYYY-MM-DD" }, { status: 400 });
  }
  const from = startOfDay(parseDayParam(fromRaw) ?? new Date(Date.now() - 13 * 86400000));
  const to = endOfDay(parseDayParam(toRaw) ?? new Date());

  try {
    const orders = await db.posOrder.findMany({
      where: {
        propertyId,
        createdAt: { gte: from, lte: to },
        status: { not: "cancelled" },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderType: true,
        totalAmount: true,
        paymentStatus: true,
        items: { select: { qty: true, amount: true, menuItem: { select: { category: true } } } },
      },
    });

    const ordersCount = orders.length;
    let covers = 0;
    let revenue = 0;
    const byCategory = new Map<string, { revenue: number; covers: number }>();
    for (const o of orders) {
      revenue += o.totalAmount;
      for (const it of o.items) {
        covers += it.qty;
        const cat = it.menuItem?.category ?? "other";
        const agg = byCategory.get(cat) ?? { revenue: 0, covers: 0 };
        agg.revenue += it.amount;
        agg.covers += it.qty;
        byCategory.set(cat, agg);
      }
    }

    const revenueByCategory = [...byCategory.entries()]
      .map(([category, v]) => ({ category, revenue: round2(v.revenue), covers: v.covers }))
      .sort((a, b) => b.revenue - a.revenue);

    const payments = await db.payment.findMany({
      where: { propertyId, posOrderId: { not: null }, createdAt: { gte: from, lte: to }, status: { in: ["success", "refund"] } },
      select: { method: true, amount: true, status: true },
    });
    const paymentMix = { cash: 0, upi: 0, card: 0, netbanking: 0, razorpay: 0 } as Record<string, number>;
    for (const p of payments) {
      const signed = p.status === "refund" ? -p.amount : p.amount;
      paymentMix[p.method] = (paymentMix[p.method] ?? 0) + signed;
    }
    Object.keys(paymentMix).forEach((k) => {
      paymentMix[k] = round2(paymentMix[k]);
    });

    const byType: Record<string, number> = {};
    for (const o of orders) byType[o.orderType] = (byType[o.orderType] ?? 0) + 1;

    return NextResponse.json({
      from: dayKey(from),
      to: dayKey(to),
      ordersCount,
      covers,
      revenue: round2(revenue),
      avgOrderValue: ordersCount > 0 ? round2(revenue / ordersCount) : 0,
      revenueByCategory,
      paymentMix,
      ordersByType: byType,
    });
  } catch (e) {
    console.error("[reports/pos]", e);
    return NextResponse.json({ error: "Could not build F&B report" }, { status: 500 });
  }
}
