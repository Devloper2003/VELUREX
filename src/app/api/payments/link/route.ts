import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { createRazorpayPaymentLink, gatewayCreds, isOnlineProvider } from "@/lib/payment-gateways";

/**
 * POST /api/payments/link — create a hosted payment link through the TENANT's
 * own gateway. The guest opens the link (WhatsApp / SMS / email) and pays on
 * the provider's page; the money settles into the tenant's account and the
 * /api/payments/webhook/[gatewayId] endpoint marks the folio paid.
 *
 * body: { reservationId?, amount, description?, customerName?, customerPhone?, customerEmail?, gatewayId? }
 */

const ROLES = ["hotel_admin", "front_desk"];
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ROLES);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const reservationId = typeof body.reservationId === "string" ? body.reservationId : "";
  const gatewayId = typeof body.gatewayId === "string" ? body.gatewayId : "";
  const amount = round2(Number(body.amount));
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
  const customerName = typeof body.customerName === "string" ? body.customerName.trim().slice(0, 120) : "";
  const customerPhone = typeof body.customerPhone === "string" ? body.customerPhone.trim().slice(0, 20) : "";
  const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim().slice(0, 160) : "";

  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "A positive amount is required" }, { status: 400 });
  }

  let reservation: { id: string; confirmationNumber: string } | null = null;
  if (reservationId) {
    const r = await db.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: { id: true, confirmationNumber: true },
    });
    if (!r) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    reservation = r;
  }

  // ── Resolve the tenant's gateway ─────────────────────────────────────────
  const candidates = await db.paymentGateway.findMany({
    where: { propertyId, enabled: true, ...(gatewayId ? { id: gatewayId } : {}) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const gateway = candidates.find((g) => isOnlineProvider(g.provider));
  if (!gateway) {
    return NextResponse.json(
      { error: "No online payment gateway is linked yet — add your Razorpay account in Settings → Payments" },
      { status: 400 }
    );
  }

  // ── Create the hosted link at the tenant's gateway ───────────────────────
  const referenceId = `vlx-${reservation?.confirmationNumber || "direct"}-${Date.now().toString(36)}`;
  const link = await createRazorpayPaymentLink(gateway, {
    amount,
    description: description || (reservation ? `Stay ${reservation.confirmationNumber}` : "Hotel payment"),
    customer: { name: customerName || undefined, phone: customerPhone || undefined, email: customerEmail || undefined },
    referenceId,
  });
  if (!link.ok || !link.linkId || !link.shortUrl) {
    return NextResponse.json({ error: link.error || "The gateway refused the payment link" }, { status: 502 });
  }

  const payment = await db.payment.create({
    data: {
      propertyId,
      reservationId: reservationId || null,
      amount,
      method: gateway.provider,
      status: "pending",
      reference: link.linkId,
      gatewayId: gateway.id,
      receivedBy: auth.session.name,
    },
  });

  const creds = gatewayCreds(gateway.secret, gateway.merchantId);
  return NextResponse.json(
    {
      paymentId: payment.id,
      link: { id: link.linkId, shortUrl: link.shortUrl },
      gateway: { id: gateway.id, provider: gateway.provider, label: gateway.label, mode: gateway.mode },
      mode: creds.keySecret ? gateway.mode : "unconfigured",
    },
    { status: 201 }
  );
}
