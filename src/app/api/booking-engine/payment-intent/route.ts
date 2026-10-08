import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPrimaryProperty } from "../_shared";
import { round2 } from "../_shared";
import { createRazorpayOrder, gatewayCreds, isOnlineProvider } from "@/lib/payment-gateways";
import { handleRoute } from "@/lib/route-error";

/**
 * POST /api/booking-engine/payment-intent — public: creates the payment order
 * for the guest booking widget.
 *
 * Order of preference:
 *   1. The property's default ENABLED online gateway (the TENANT's own
 *      Razorpay/Stripe account — money settles into the tenant's account).
 *   2. Platform-level RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env keys.
 *   3. A mock order so the widget flow stays testable in development.
 * Always 200.
 */
export async function POST(req: NextRequest) {
  return handleRoute("booking.paymentIntent", () => paymentIntentPost(req));
}

async function paymentIntentPost(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as
    | { amount?: number; name?: string; phone?: string; email?: string }
    | null;

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "A positive amount is required" }, { status: 400 });

  // ── 1. The tenant's own gateway (resolved via ?property= / default) ───────
  try {
    const property = await getPrimaryProperty(req.nextUrl.searchParams.get("property") || undefined);
    if (property) {
      const gateways = await db.paymentGateway.findMany({
        where: { propertyId: property.id, enabled: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      const gateway = gateways.find((g) => isOnlineProvider(g.provider));
      if (gateway) {
        const creds = gatewayCreds(gateway.secret, gateway.merchantId);
        if (creds.keyId && creds.keySecret) {
          const order = await createRazorpayOrder(gateway, {
            amount,
            receipt: `bk-${Date.now().toString(36)}`,
            customer: { name: body?.name, phone: body?.phone, email: body?.email },
          });
          if (order.ok && order.orderId) {
            return NextResponse.json({
              mock: false,
              provider: gateway.provider,
              gatewayLabel: gateway.label,
              mode: gateway.mode,
              orderId: order.orderId,
              amount: round2(amount),
              keyId: creds.keyId,
            });
          }
          // Tenant gateway misconfigured → surface it, don't silently charge elsewhere.
          return NextResponse.json({
            mock: true,
            orderId: `order_mock_${Date.now()}`,
            amount: round2(amount),
            error: order.error,
          });
        }
      }
    }
  } catch {
    // fall through to platform fallback
  }

  // ── 2. Platform-level env keys ────────────────────────────────────────────
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (keyId && keySecret) {
    try {
      const res = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: Math.round(amount * 100), // paise
          currency: "INR",
          receipt: `rcpt-${Date.now()}`,
        }),
      });
      const order = (await res.json()) as { id?: string; error?: { description?: string } };
      if (res.ok && order.id) {
        return NextResponse.json({ mock: false, orderId: order.id, amount: round2(amount), keyId });
      }
    } catch {
      // fall through to mock so the guest flow never breaks
    }
  }

  return NextResponse.json({
    mock: true,
    orderId: `order_mock_${Date.now()}`,
    amount: round2(amount),
  });
}
