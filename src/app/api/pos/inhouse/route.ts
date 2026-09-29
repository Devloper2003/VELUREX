import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/** GET /api/pos/inhouse — checked-in reservations for the room-service picker. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const reservations = await db.reservation.findMany({
    where: { propertyId, status: "checked_in" },
    include: { guest: true, room: true },
    orderBy: [{ room: { number: "asc" } }],
  });

  return NextResponse.json({
    guests: reservations.map((r) => ({
      reservationId: r.id,
      confirmationNumber: r.confirmationNumber,
      guestName: r.guest.fullName,
      roomNumber: r.room?.number ?? "—",
      checkIn: r.checkIn,
      checkOut: r.checkOut,
    })),
  });
}
