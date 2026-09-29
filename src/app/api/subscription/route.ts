import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getTenantEntitlements } from "@/lib/entitlements";

/**
 * GET /api/subscription — tenant-side "My Subscription": current plan, usage
 * vs limits, renewal, invoices, available plans for upgrade, add-ons.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  if (!propertyId) return NextResponse.json({ error: "No tenant context" }, { status: 400 });

  const ent = await getTenantEntitlements(propertyId);
  const [plans, invoices, roomCount, staffCount, channelCount, waThisMonth, addons] = await Promise.all([
    db.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    db.invoice.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
      take: 24,
      include: { items: true },
    }),
    db.room.count({ where: { propertyId } }),
    db.staff.count({ where: { propertyId } }),
    db.channelConnection.count({ where: { propertyId, status: { not: "disconnected" } } }),
    db.whatsAppMessage.count({
      where: { propertyId, createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
    }),
    db.subscriptionAddon.findMany({ where: { propertyId, active: true } }),
  ]);

  return NextResponse.json({
    plan: ent.plan,
    subscription: ent.subscription,
    features: ent.features,
    limits: ent.limits,
    addons: ent.addons,
    overrides: ent.overrides,
    warning: ent.warning,
    writable: ent.writable,
    usage: {
      rooms: { used: roomCount, cap: ent.limits.rooms },
      staff: { used: staffCount, cap: ent.limits.staff },
      ota_channels: { used: channelCount, cap: ent.limits.ota_channels },
      whatsapp_msgs: { used: waThisMonth, cap: ent.limits.whatsapp_msgs },
    },
    plans: plans.map((p) => {
      let features: Record<string, unknown> = {};
      try { features = JSON.parse(p.features); } catch { /* noop */ }
      return { id: p.id, code: p.code, name: p.name, description: p.description, monthlyPrice: p.monthlyPrice, features };
    }),
    invoices: invoices.map((i) => ({
      id: i.id, number: i.number, type: i.type, status: i.status,
      totalAmount: i.totalAmount, taxAmount: i.taxAmount, subtotal: i.subtotal,
      dueDate: i.dueDate, paidAt: i.paidAt, createdAt: i.createdAt,
      items: i.items.map((it) => ({ description: it.description, amount: it.amount })),
    })),
    paymentMethods: { razorpay: false, note: "Pay via UPI/bank transfer — Razorpay checkout coming soon." },
  });
}
