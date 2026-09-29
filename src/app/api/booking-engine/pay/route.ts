import { NextRequest, NextResponse } from "next/server";
import {
  HoldExpiredError,
  HoldStateError,
  confirmHoldPayment,
  declineHoldPayment,
  releaseHold,
} from "@/lib/booking-guard";

/**
 * POST /api/booking-engine/pay — phase B of the race-safe booking flow.
 *
 * Public. Settles the payment against a hold:
 *   outcome "success"  → room + payment claimed atomically, reservation created
 *                        (Razorpay-shaped Payment row, price locked at hold time)
 *   outcome "failure"  → hold released instantly (room back in inventory),
 *                        failed Payment row written for the audit trail
 *   outcome "release"  → guest abandoned checkout — same instant release
 *
 * Concurrency guarantees:
 *   • N parallel "success" calls → exactly one creates the reservation; the
 *     others receive the winner's confirmation (idempotent replay).
 *   • success vs failure racing → one claim wins the status-guarded flip.
 *   • success after TTL → 410 Gone, hold swept, guest re-searches.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    holdId?: string;
    outcome?: "success" | "failure" | "release";
    gatewayRef?: string;
    reason?: string;
    paymentMethod?: string;
  } | null;

  if (!body?.holdId) return NextResponse.json({ error: "holdId is required" }, { status: 400 });
  const outcome = body.outcome ?? "success";

  try {
    if (outcome === "success") {
      const result = await confirmHoldPayment({
        holdId: body.holdId,
        gatewayRef: body.gatewayRef?.trim() || `pay_${Date.now().toString(36)}`,
        paymentMethod: body.paymentMethod,
        payNow: true,
      });
      return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
    }

    if (outcome === "failure") {
      const result = await declineHoldPayment({
        holdId: body.holdId,
        gatewayRef: body.gatewayRef,
        reason: body.reason,
      });
      return NextResponse.json(result);
    }

    // outcome === "release"
    const released = await releaseHold(body.holdId, "guest abandoned checkout");
    return NextResponse.json({ outcome: "released", released });
  } catch (e) {
    if (e instanceof HoldExpiredError) {
      return NextResponse.json({ error: e.message, code: "HOLD_EXPIRED" }, { status: 410 });
    }
    if (e instanceof HoldStateError) {
      return NextResponse.json({ error: e.message, code: "HOLD_STATE" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Payment settlement failed" }, { status: 500 });
  }
}
