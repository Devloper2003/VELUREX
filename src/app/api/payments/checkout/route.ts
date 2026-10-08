import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { createRazorpayOrder, gatewayCreds, isOnlineProvider } from "@/lib/payment-gateways";
import { handleRoute } from "@/lib/route-error";

/**
 * POST /api/payments/checkout — start an online collection through the
 * TENANT's own gateway.
 *
 * body: { amount, reservationId?, posOrderId?, gatewayId?, description? }
 *
 * Resolves the gateway (explicit → property default → first enabled online),
 * creates the order AT THE TENANT'S GATEWAY (Razorpay Orders API with the
 * tenant's keys) and writes a `pending` Payment row that the verify/webhook
 * step finalizes. Money lands in the tenant's own account.
 */

const ROLES = ["hotel_admin", "front_desk", "restaurant_staff"];
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function POST(req: NextRequest) {
  return handleRoute("payments.checkout", () => checkoutPost(req));
}

async function checkoutPost(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, ROLES);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const reservationId = typeof body.reservationId === "string" ? body.reservationId : "";
  const posOrderId = typeof body.posOrderId === "string" ? body.posOrderId : "";
  const gatewayId = typeof body.gatewayId === "string" ? body.gatewayId : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 120) : "";

  // ── Resolve target ────────────────────────────────────────────────────────
  let reservation: { id: string; confirmationNumber: string; guestId: string | null } | null = null;
  let posOrder: { id: string; orderNumber: string; totalAmount: number; paymentStatus: string } | null = null;
  let amount = Number(body.amount);

  if (posOrderId) {
    const o = await db.posOrder.findFirst({
      where: { id: posOrderId, propertyId },
      select: { id: true, orderNumber: true, totalAmount: true, paymentStatus: true },
    });
    if (!o) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (o.paymentStatus !== "unpaid") {
      return NextResponse.json({ error: `Order is already ${o.paymentStatus.replace("_", " ")}` }, { status: 400 });
    }
    posOrder = o;
    amount = o.totalAmount;
  } else if (reservationId) {
    const r = await db.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: { id: true, confirmationNumber: true, guestId: true },
    });
    if (!r) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "A positive amount is required" }, { status: 400 });
    }
    reservation = r;
  } else {
    return NextResponse.json({ error: "reservationId or posOrderId is required" }, { status: 400 });
  }
  amount = round2(amount);

  // ── Resolve the tenant's gateway ─────────────────────────────────────────
  const where = {
    propertyId,
    enabled: true,
    ...(gatewayId ? { id: gatewayId } : {}),
  };
  const candidates = await db.paymentGateway.findMany({
    where,
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const gateway = candidates.find((g) => isOnlineProvider(g.provider));
  if (!gateway) {
    return NextResponse.json(
      {
        error: gatewayId
          ? "That gateway is unavailable or does not support online collection"
          : "No online payment gateway is linked yet — add your Razorpay/Stripe account in Settings → Payments",
      },
      { status: 400 }
    );
  }

  // ── Idempotency: an unfinished checkout for the same target reuses its order
  const existing = await db.payment.findFirst({
    where: {
      propertyId,
      status: "pending",
      method: gateway.provider,
      gatewayId: gateway.id,
      ...(reservationId ? { reservationId } : {}),
      ...(posOrderId ? { posOrderId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, reference: true, amount: true },
  });
  if (existing && existing.reference.startsWith("order_mock_")) {
    const creds = gatewayCreds(gateway.secret, gateway.merchantId);
    return NextResponse.json({
      paymentId: existing.id,
      gateway: { id: gateway.id, provider: gateway.provider, label: gateway.label, mode: gateway.mode },
      checkout: { orderId: existing.reference, amount: existing.amount, keyId: creds.keyId, currency: "INR", mock: true },
    });
  }

  // ── Create the order at the tenant's gateway ─────────────────────────────
  const receipt = posOrder ? posOrder.orderNumber : reservation?.confirmationNumber || `fol-${Date.now()}`;
  const order = await createRazorpayOrder(gateway, {
    amount,
    receipt: `vlx-${receipt}`,
    notes: { source: posOrder ? "pos" : "folio", ref: posOrder?.orderNumber || reservation?.confirmationNumber || "" },
  });
  if (!order.ok || !order.orderId) {
    return NextResponse.json({ error: order.error || "The gateway refused the order" }, { status: 502 });
  }

  const payment = await db.payment.create({
    data: {
      propertyId,
      reservationId: reservationId || null,
      posOrderId: posOrderId || null,
      amount,
      method: gateway.provider,
      status: "pending",
      reference: order.orderId,
      gatewayId: gateway.id,
      receivedBy: auth.session.name,
    },
  });

  const creds = gatewayCreds(gateway.secret, gateway.merchantId);
  return NextResponse.json(
    {
      paymentId: payment.id,
      gateway: { id: gateway.id, provider: gateway.provider, label: gateway.label, mode: gateway.mode },
      checkout: {
        orderId: order.orderId,
        amount,
        keyId: creds.keyId,
        currency: "INR",
        mock: order.mock === true,
        description: description || (posOrder ? `POS ${posOrder.orderNumber}` : `Stay ${reservation?.confirmationNumber ?? ""}`),
      },
    },
    { status: 201 }
  );
}
