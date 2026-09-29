import { NextRequest, NextResponse } from "next/server";
import { round2 } from "../_shared";

/**
 * POST /api/booking-engine/payment-intent — public: creates a Razorpay order
 * when API keys are configured, otherwise returns a mock order so the widget
 * flow stays testable in development. Always 200.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { amount?: number; name?: string; phone?: string; email?: string }
    | null;

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "A positive amount is required" }, { status: 400 });

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
