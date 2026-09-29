import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { startOfDay } from "@/lib/business";

/**
 * GET /api/calendar?start=YYYY-MM-DD&days=14
 * Returns the day window, rooms and every non-cancelled reservation that
 * overlaps the window — powering the drag & drop availability grid.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const startParam = searchParams.get("start");
  const daysParam = Number(searchParams.get("days"));

  const start = startParam && !Number.isNaN(new Date(startParam).getTime())
    ? new Date(new Date(startParam).getFullYear(), new Date(startParam).getMonth(), new Date(startParam).getDate())
    : startOfDay(new Date());
  const days = Number.isNaN(daysParam) || daysParam <= 0 ? 14 : Math.min(Math.max(daysParam, 1), 60);
  const windowEnd = new Date(start.getTime() + days * 86400000);

  const [rooms, reservations] = await Promise.all([
    db.room.findMany({
      where: { propertyId },
      include: { roomType: { select: { id: true, name: true, code: true } } },
      orderBy: [{ floor: "asc" }, { number: "asc" }],
    }),
    db.reservation.findMany({
      where: {
        propertyId,
        status: { notIn: ["cancelled", "no_show"] },
        checkIn: { lt: windowEnd },
        checkOut: { gt: start },
      },
      include: { guest: { select: { id: true, fullName: true } } },
      orderBy: { checkIn: "asc" },
    }),
  ]);

  const dayList: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dayList.push(`${y}-${m}-${day}`);
  }

  return NextResponse.json({
    start: dayList[0],
    days: dayList,
    rooms: rooms.map((r) => ({
      id: r.id,
      number: r.number,
      floor: r.floor,
      status: r.status,
      roomTypeId: r.roomType.id,
      roomTypeName: r.roomType.name,
      roomTypeCode: r.roomType.code,
    })),
    reservations: reservations.map((res) => ({
      id: res.id,
      confirmationNumber: res.confirmationNumber,
      guestName: res.guest.fullName,
      roomId: res.roomId,
      roomTypeId: res.roomTypeId,
      checkIn: res.checkIn,
      checkOut: res.checkOut,
      status: res.status,
      nights: res.nights,
      nightlyRate: res.nightlyRate,
      totalAmount: res.totalAmount,
    })),
  });
}
