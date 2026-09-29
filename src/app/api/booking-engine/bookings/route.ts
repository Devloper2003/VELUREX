import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/booking-engine/bookings — auth (hotel_admin, front_desk): recent
 * online (booking_engine) reservations with guest + room type, plus the promo
 * code list for the configuration panel.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const [reservations, promoCodes] = await Promise.all([
    db.reservation.findMany({
      where: { propertyId, source: "booking_engine" },
      include: {
        guest: { select: { id: true, fullName: true, phone: true, email: true } },
        roomType: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.promoCode.findMany({ where: { propertyId }, orderBy: { validFrom: "asc" } }),
  ]);

  return NextResponse.json({ reservations, promoCodes });
}
