import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { nextInvoiceNumber, platformGstRate, cyclePrice, logPlatformAction } from "@/lib/platform";

/**
 * POST /api/subscription — tenant self-service actions:
 *   upgrade        → immediate plan change + prorated invoice
 *   request_downgrade → scheduled for next renewal (pendingPlanId)
 *   buy_addon      → recurring add-on pack + invoice
 *   pay_now        → records an offline payment intent against an invoice (stub gateway)
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;
  if (!propertyId) return NextResponse.json({ error: "No tenant context" }, { status: 400 });

  const sub = await db.subscription.findUnique({ where: { propertyId }, include: { plan: true, property: true } });
  if (!sub) return NextResponse.json({ error: "No subscription found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "upgrade") {
    const plan = await db.plan.findUnique({ where: { id: String(body.planId ?? "") } });
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    if (plan.monthlyPrice <= sub.plan.monthlyPrice)
      return NextResponse.json({ error: "Use a higher-tier plan to upgrade" }, { status: 400 });
    const cycle = ["monthly", "quarterly", "yearly"].includes(String(body.cycle)) ? String(body.cycle) : sub.cycle;

    const oldCyclePrice = await cyclePrice(sub.plan.monthlyPrice, sub.cycle);
    const newCyclePrice = await cyclePrice(plan.monthlyPrice, cycle);
    const now = Date.now();
    const renewal = sub.renewalAt?.getTime() ?? now;
    const cycleMs = (sub.cycle === "yearly" ? 365 : sub.cycle === "quarterly" ? 90 : 30) * 86400000;
    const credit = cycleMs > 0 ? Math.max(0, (oldCyclePrice * (renewal - now)) / cycleMs) : 0;
    const net = Math.max(0, Math.round((newCyclePrice - credit) * 100) / 100);
    const gst = await platformGstRate();
    const tax = Math.round(net * (gst / 100) * 100) / 100;
    const number = await nextInvoiceNumber();
    const inv = await db.invoice.create({
      data: {
        number, propertyId, subscriptionId: sub.id, type: "subscription", status: "pending",
        subtotal: newCyclePrice, discountAmount: Math.round(credit * 100) / 100,
        taxAmount: tax, totalAmount: Math.round((net + tax) * 100) / 100,
        periodStart: new Date(), periodEnd: sub.renewalAt,
        dueDate: new Date(now + 7 * 86400000),
        notes: `Self-serve upgrade ${sub.plan.name} → ${plan.name}`,
      },
    });
    await db.invoiceItem.create({
      data: { invoiceId: inv.id, description: `${plan.name} plan — ${cycle}`, qty: 1, unitPrice: newCyclePrice, taxRate: gst, amount: newCyclePrice },
    });
    await db.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, cycle, status: "active", pendingPlanId: null } });
    await db.property.update({ where: { id: propertyId }, data: { currentPlanId: plan.id, subscriptionStatus: "active" } });
    await clearEntitlementsCache(propertyId);
    await logPlatformAction({
      actorName: session.email, action: "SELF_SERVE_UPGRADE", entity: "subscription", entityId: sub.id,
      propertyId, details: `${sub.property.name}: ${sub.plan.name} → ${plan.name} — invoice ${number}`,
    });
    return NextResponse.json({ ok: true, invoiceNumber: number, invoiceId: inv.id });
  }

  if (action === "request_downgrade") {
    const plan = await db.plan.findUnique({ where: { id: String(body.planId ?? "") } });
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    await db.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: plan.id } });
    await logPlatformAction({
      actorName: session.email, action: "SELF_SERVE_DOWNGRADE", entity: "subscription", entityId: sub.id,
      propertyId, details: `${sub.property.name}: downgrade to ${plan.name} scheduled at renewal`,
    });
    return NextResponse.json({ ok: true, effectiveAt: sub.renewalAt });
  }

  if (action === "buy_addon") {
    const catalog: Record<string, { label: string; price: number; oneOff: boolean }> = {
      rooms_pack: { label: "Extra Rooms Pack (+10 rooms)", price: 999, oneOff: false },
      staff_pack: { label: "Extra Staff Pack (+5 seats)", price: 499, oneOff: false },
      whatsapp_pack: { label: "WhatsApp Pack (+100 msgs/mo)", price: 499, oneOff: false },
      ota_pack: { label: "Extra OTA Channel", price: 799, oneOff: false },
    };
    const addonKey = String(body.addonKey ?? "");
    const item = catalog[addonKey];
    if (!item) return NextResponse.json({ error: "Unknown add-on" }, { status: 400 });

    const gst = await platformGstRate();
    const tax = Math.round(item.price * (gst / 100) * 100) / 100;
    const number = await nextInvoiceNumber();
    const inv = await db.invoice.create({
      data: {
        number, propertyId, subscriptionId: sub.id, type: "addon", status: "pending",
        subtotal: item.price, taxAmount: tax, totalAmount: Math.round((item.price + tax) * 100) / 100,
        dueDate: new Date(Date.now() + 7 * 86400000),
      },
    });
    await db.invoiceItem.create({
      data: { invoiceId: inv.id, description: item.label, qty: 1, unitPrice: item.price, taxRate: gst, amount: item.price },
    });
    await db.subscriptionAddon.create({
      data: { propertyId, addonKey, label: item.label, qty: 1, price: item.price, oneOff: item.oneOff },
    });
    await clearEntitlementsCache(propertyId);
    await logPlatformAction({
      actorName: session.email, action: "SELF_SERVE_ADDON", entity: "subscription", entityId: sub.id,
      propertyId, details: `${sub.property.name}: bought ${item.label} — invoice ${number}`,
    });
    return NextResponse.json({ ok: true, invoiceNumber: number, invoiceId: inv.id });
  }

  if (action === "pay_now") {
    const invoiceId = String(body.invoiceId ?? "");
    const invoice = await db.invoice.findFirst({ where: { id: invoiceId, propertyId } });
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    // TODO: real Razorpay checkout — record a pending payment + mock reference for now.
    await db.platformPayment.create({
      data: {
        invoiceId: invoice.id, propertyId, amount: invoice.totalAmount,
        method: "upi", status: "pending", kind: "payment",
        reference: `pending_${Date.now()}`, notes: "Awaiting gateway confirmation (stub)",
      },
    });
    await logPlatformAction({
      actorName: session.email, action: "PAYMENT_INITIATED", entity: "invoice", entityId: invoice.id,
      propertyId, details: `${sub.property.name}: payment initiated for ${invoice.number}`,
    });
    return NextResponse.json({
      ok: true,
      note: "Payment gateway not configured — your payment is recorded as pending. Contact support to complete, or the owner will confirm manually.",
    });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
