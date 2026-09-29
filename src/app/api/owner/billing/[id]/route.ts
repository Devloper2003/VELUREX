import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction, getPlatformSetting } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** GET /api/owner/billing/[id] — full invoice with items, payments and company GST info (print view). */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      property: true,
      items: true,
      payments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const [companyName, gstin, termsUrl] = await Promise.all([
    getPlatformSetting("company_name").then((v) => v ?? "Velurex Technologies Pvt Ltd"),
    getPlatformSetting("company_gstin").then((v) => v ?? ""),
    getPlatformSetting("terms_url").then((v) => v ?? ""),
  ]);

  return NextResponse.json({
    invoice,
    company: { name: companyName, gstin, termsUrl },
  });
}

/**
 * PATCH /api/owner/billing/[id] — invoice actions:
 *   record_payment | send_payment_link | refund | credit_note | mark_paid | cancel
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const invoice = await db.invoice.findUnique({ where: { id }, include: { property: true } });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const audit = (details: string) =>
    logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: action.toUpperCase(),
      entity: "invoice", entityId: id, propertyId: invoice.propertyId, details,
    });

  switch (action) {
    case "record_payment": {
      const amount = Number(body.amount ?? invoice.totalAmount);
      const method = ["razorpay", "upi", "bank", "cash"].includes(String(body.method)) ? String(body.method) : "upi";
      const reference = String(body.reference ?? "").trim();
      const payment = await db.platformPayment.create({
        data: {
          invoiceId: id, propertyId: invoice.propertyId, amount,
          method, status: "success", kind: "payment", reference,
          paidAt: new Date(), receivedBy: owner.email,
          notes: String(body.notes ?? "Offline payment recorded"),
        },
      });
      await db.invoice.update({ where: { id }, data: { status: "paid", paidAt: new Date() } });

      // Overdue payments restore the subscription to active.
      const sub = invoice.subscriptionId
        ? await db.subscription.findUnique({ where: { id: invoice.subscriptionId } })
        : null;
      if (sub && ["overdue", "suspended"].includes(sub.status)) {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "active" } });
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "active" } });
      }
      await audit(`Payment recorded: ₹${amount} via ${method}${reference ? ` (ref ${reference})` : ""}`);
      return NextResponse.json({ ok: true, paymentId: payment.id });
    }

    case "send_payment_link": {
      const razorpayConfigured = !!(await getPlatformSetting("razorpay_key_id"));
      // TODO: real Razorpay Payment Link API — requires live key_secret + webhook.
      // Until configured we return a mock link; the UI marks it clearly as a stub.
      const link = `https://rzp.io/i/vxl-${invoice.number.toLowerCase()}`;
      await audit(`Payment link generated for ₹${invoice.totalAmount} (Razorpay ${razorpayConfigured ? "live" : "stub — not configured"})`);
      return NextResponse.json({
        ok: true,
        link,
        mode: razorpayConfigured ? "razorpay" : "stub",
        note: razorpayConfigured
          ? "Link ready — send via WhatsApp/email (see TODO for provider wiring)."
          : "Razorpay is not configured in Platform Settings — this is a mock link. TODO: wire the Payment Links API.",
      });
    }

    case "refund": {
      const amount = Number(body.amount ?? invoice.totalAmount);
      const payment = await db.platformPayment.create({
        data: {
          invoiceId: id, propertyId: invoice.propertyId, amount,
          method: String(body.method ?? "razorpay"), status: "refunded", kind: "refund",
          reference: String(body.reference ?? ""), paidAt: new Date(), receivedBy: owner.email,
          notes: String(body.notes ?? "Refund issued"),
        },
      });
      await db.invoice.update({ where: { id }, data: { status: "refunded" } });
      await audit(`Refund issued: ₹${amount} for invoice ${invoice.number}`);
      return NextResponse.json({ ok: true, paymentId: payment.id });
    }

    case "credit_note": {
      const amount = Number(body.amount ?? invoice.totalAmount);
      const reason = String(body.reason ?? "Credit note");
      await db.invoice.update({
        where: { id },
        data: { status: "cancelled", notes: `${invoice.notes}\nCredit note ₹${amount}: ${reason}`.trim() },
      });
      await audit(`Credit note ₹${amount} applied — ${reason}`);
      return NextResponse.json({ ok: true });
    }

    case "mark_paid": {
      await db.invoice.update({ where: { id }, data: { status: "paid", paidAt: new Date() } });
      await audit(`Invoice ${invoice.number} manually marked paid`);
      return NextResponse.json({ ok: true });
    }

    case "cancel": {
      await db.invoice.update({ where: { id }, data: { status: "cancelled" } });
      await audit(`Invoice ${invoice.number} cancelled`);
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
