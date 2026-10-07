import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptJSON } from "@/lib/crypto";
import {
  failGatewayPayment,
  finalizeGatewayPayment,
  verifyRazorpayWebhookSignature,
} from "@/lib/payment-gateways";

/**
 * POST /api/payments/webhook/[gatewayId] — public Razorpay webhook endpoint.
 *
 * The tenant pastes this URL into THEIR Razorpay Dashboard → Settings →
 * Webhooks (with a webhook secret, which they also save in Settings →
 * Payments). Every event is verified with the gateway's own webhook secret,
 * so payments taken on Razorpay's hosted payment links / pages are marked
 * in the PMS even when the guest's browser never returns to the app.
 *
 * Handled events: payment.captured · order.paid · payment_link.paid
 * (payment.failed marks the pending row failed).
 *
 * Always 200 after signature verification (Razorpay retries non-2xx);
 * 400 only for a bad signature so misconfigurations surface in the dashboard.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ gatewayId: string }> }) {
  const { gatewayId } = await params;

  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") || "";

  const gateway = await db.paymentGateway.findUnique({
    where: { id: gatewayId },
    select: { id: true, propertyId: true, provider: true, secret: true, merchantId: true },
  });
  if (!gateway) return NextResponse.json({ ok: false, error: "Unknown gateway" }, { status: 404 });

  // Accept the dedicated webhook secret, falling back to the key secret.
  const dec = decryptJSON<{ keySecret?: string; secret?: string; webhookSecret?: string }>(gateway.secret);
  const secret = dec.webhookSecret || dec.keySecret || dec.secret || "";
  if (!secret || !verifyRazorpayWebhookSignature(raw, signature, secret)) {
    return NextResponse.json({ ok: false, error: "Invalid webhook signature" }, { status: 400 });
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string; error_description?: string } };
      order?: { entity?: { id?: string; status?: string } };
      payment_link?: { entity?: { id?: string; status?: string; reference_id?: string } };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" });
  }

  const type = event.event || "";
  const paymentEntity = event.payload?.payment?.entity;
  const linkEntity = event.payload?.payment_link?.entity;
  const orderEntity = event.payload?.order?.entity;

  // The pending Payment row is located by the razorpay order id / link id
  // stored in `reference` at checkout / link time.
  const refCandidates = [paymentEntity?.order_id, orderEntity?.id, linkEntity?.id, linkEntity?.reference_id].filter(
    (x): x is string => Boolean(x)
  );

  const findPending = async () => {
    for (const ref of refCandidates) {
      const p = await db.payment.findFirst({
        where: { propertyId: gateway.propertyId, gatewayId: gateway.id, reference: ref },
        orderBy: { createdAt: "desc" },
      });
      if (p) return p;
    }
    return null;
  };

  if (type === "payment.captured" || type === "order.paid" || type === "payment_link.paid") {
    const pending = await findPending();
    if (!pending) return NextResponse.json({ ok: true, ignored: "no matching payment row" });
    const result = await finalizeGatewayPayment({
      paymentId: pending.id,
      gatewayRef: paymentEntity?.id || "",
      via: "webhook",
    });
    return NextResponse.json({ ok: result.ok, status: result.status });
  }

  if (type === "payment.failed") {
    const pending = await findPending();
    if (pending) await failGatewayPayment(pending.id, paymentEntity?.error_description || "gateway reported failure");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: type || "unknown event" });
}
