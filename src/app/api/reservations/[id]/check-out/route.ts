import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { performCheckout } from "@/lib/checkout-core";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/reservations/[id]/check-out — check a guest out.
 * Money math (early-departure re-pricing, departure posting, promo
 * reconciliation) lives in lib/checkout-core so the bulk group check-out
 * applies exactly the same rules.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  let outcome;
  try {
    outcome = await performCheckout({
      propertyId,
      reservationId: id,
      staff: { sub: auth.session.sub, name: auth.session.name },
    });
  } catch (e) {
    const msg = (e as Error).message || "Check-out failed";
    const status = msg.includes("not found") ? 404 : msg.includes("Only checked-in") ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // Same enriched reservation payload the endpoint has always returned.
  const updated = await db.reservation.findUnique({
    where: { id },
    include: {
      guest: { select: { id: true, fullName: true, phone: true, email: true } },
      room: { include: { roomType: { select: { name: true, code: true } } } },
      roomType: { select: { name: true, code: true } },
    },
  });

  return NextResponse.json({
    reservation: updated,
    balance: outcome.balance,
    folioTotal: outcome.folioTotal,
    discountPosted: outcome.discountPosted,
    departureRoomChargeNights: outcome.departureRoomChargeNights,
    departureRoomCharge: outcome.departureRoomCharge,
    ...(outcome.earlyDeparture ? { earlyDeparture: outcome.earlyDeparture } : {}),
  });
}
