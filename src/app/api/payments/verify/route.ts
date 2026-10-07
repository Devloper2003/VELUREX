import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import {
  failGatewayPayment,
  finalizeGatewayPayment,
  gatewayCreds,
  verifyRazorpayCheckoutSignature,
} from "@/lib/payment-gateways";

/**
 * POST /api/payments/verify — complete an online collection started by
 * /api/payments/checkout.
 *
 * Real Razorpay flow: the browser posts the checkout handshake
 * { paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * and the signature is verified with the TENANT's key secret before the
 * payment is applied.
 *
 * Sandbox flow: when the order was created in mock mode (gateway without a
 * full credential pair), { paymentId, mock: true } confirms it — only allowed
 * for references the server itself minted (order_mock_*).
 */

const ROLES = ["hotel_admin", "front_desk", "restaurant_staff"];

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ROLES);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
  if (!paymentId) return NextResponse.json({ error: "paymentId is required" }, { status: 400 });

  const payment = await db.payment.findFirst({ where: { id: paymentId, propertyId } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  if (payment.status === "success") {
    return NextResponse.json({ payment, idempotentReplay: true });
  }
  if (payment.status !== "pending") {
    return NextResponse.json({ error: `This payment is ${payment.status} — start a new collection.` }, { status: 409 });
  }

  // ── Load the gateway (must still exist & belong to this property) ─────────
  const gateway = payment.gatewayId
    ? await db.paymentGateway.findFirst({ where: { id: payment.gatewayId, propertyId } })
    : null;
  if (!gateway) return NextResponse.json({ error: "The linked gateway no longer exists" }, { status: 409 });

  const creds = gatewayCreds(gateway.secret, gateway.merchantId);
  const isMockOrder = payment.reference.startsWith("order_mock_");

  if (body.mock === true) {
    // Sandbox confirmation — only for mock orders, and only when the gateway
    // genuinely has no credential pair (so this can never bypass a real one).
    if (!isMockOrder || creds.keySecret) {
      return NextResponse.json({ error: "Simulated confirmation is not allowed for this payment" }, { status: 400 });
    }
    const result = await finalizeGatewayPayment({
      paymentId: payment.id,
      gatewayRef: `pay_mock_${Date.now().toString(36)}`,
      via: "checkout",
      actorName: auth.session.name,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    const fresh = await db.payment.findUnique({ where: { id: payment.id } });
    return NextResponse.json({ payment: fresh, simulated: true });
  }

  // ── Real Razorpay handshake verification ──────────────────────────────────
  const rzpPaymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
  const rzpOrderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
  const rzpSignature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";

  if (!rzpPaymentId || !rzpOrderId || !rzpSignature) {
    return NextResponse.json({ error: "razorpay_order_id, razorpay_payment_id and razorpay_signature are required" }, { status: 400 });
  }
  if (rzpOrderId !== payment.reference) {
    return NextResponse.json({ error: "Order id mismatch — this response belongs to a different order" }, { status: 400 });
  }
  if (!creds.keySecret) {
    return NextResponse.json({ error: "Gateway has no key secret saved — cannot verify the payment" }, { status: 409 });
  }

  const valid = verifyRazorpayCheckoutSignature(rzpOrderId, rzpPaymentId, rzpSignature, creds.keySecret);
  if (!valid) {
    await failGatewayPayment(payment.id, "checkout signature verification failed");
    return NextResponse.json({ error: "Signature verification failed — the payment was NOT applied" }, { status: 400 });
  }

  const result = await finalizeGatewayPayment({
    paymentId: payment.id,
    gatewayRef: rzpPaymentId,
    via: "checkout",
    actorName: auth.session.name,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const fresh = await db.payment.findUnique({ where: { id: payment.id } });
  return NextResponse.json({ payment: fresh });
}
