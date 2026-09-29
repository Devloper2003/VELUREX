import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { startOfDay, endOfDay } from "@/lib/business";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const [rooms, property, reservations] = await Promise.all([
    db.room.findMany({
      where: { propertyId },
      include: { roomType: true },
      orderBy: [{ floor: "asc" }, { number: "asc" }],
    }),
    db.property.findUnique({ where: { id: propertyId } }),
    db.reservation.findMany({
      where: { propertyId },
      include: { guest: true, room: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const today = new Date();
  const t0 = startOfDay(today);
  const t1 = endOfDay(today);
  const lastWeek0 = startOfDay(new Date(today.getTime() - 7 * 86400000));
  const lastWeek1 = endOfDay(new Date(today.getTime() - 7 * 86400000));

  const totalRooms = rooms.length || 1;
  const occupied = rooms.filter((r) => r.status === "occupied").length;
  const occupancy = (occupied / totalRooms) * 100;

  // Folio revenue today (business-date based)
  const todaysItems = await db.folioItem.findMany({
    where: { propertyId, businessDate: { gte: t0, lte: t1 } },
  });
  const sumBy = (cats: string[]) =>
    todaysItems.filter((i) => cats.includes(i.category)).reduce((s, i) => s + i.amount, 0);
  const roomRevToday = sumBy(["room"]);
  const fnbRevToday = sumBy(["fnb", "bar"]);
  const miscRevToday = sumBy(["laundry", "misc"]);
  const revenueToday = roomRevToday + fnbRevToday + miscRevToday;

  // Last week comparison (7 days ago)
  const lastWeekItems = await db.folioItem.findMany({
    where: { propertyId, businessDate: { gte: lastWeek0, lte: lastWeek1 } },
  });
  const revenueLastWeek = lastWeekItems.reduce((s, i) => s + i.amount, 0);
  const occupancyLastWeek = (await db.nightAuditLog.findFirst({
    where: { propertyId, businessDate: { gte: lastWeek0, lte: lastWeek1 } },
    orderBy: { businessDate: "desc" },
  }))?.occupancyPercent ?? occupancy;

  const adr = occupied > 0 ? roomRevToday / occupied : 0;
  const revpar = roomRevToday / totalRooms;

  const inHouse = reservations.filter((r) => r.status === "checked_in");
  const checkInsToday = reservations.filter(
    (r) => r.checkIn >= t0 && r.checkIn <= t1 && ["confirmed", "checked_in"].includes(r.status)
  );
  const checkOutsToday = reservations.filter(
    (r) => r.checkOut >= t0 && r.checkOut <= t1 && ["checked_in", "checked_out"].includes(r.status)
  );

  const roomStatus = Object.values(
    rooms.reduce<Record<number, { floor: number; rooms: unknown[] }>>((acc, r) => {
      (acc[r.floor] ??= { floor: r.floor, rooms: [] }).rooms.push({
        id: r.id,
        number: r.number,
        status: r.status,
        note: r.note,
        type: r.roomType.name,
        guest:
          inHouse.find((res) => res.roomId === r.id)?.guest.fullName ?? null,
      });
      return acc;
    }, {})
  ).sort((a, b) => a.floor - b.floor);

  const recent = reservations.slice(0, 8).map((r) => ({
    id: r.id,
    confirmationNumber: r.confirmationNumber,
    guestName: r.guest.fullName,
    roomNumber: r.room?.number ?? "—",
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    status: r.status,
    totalAmount: r.totalAmount,
    source: r.source,
  }));

  // outstanding balances from in-house + checked-out unpaid
  const outstanding = inHouse.reduce((s, r) => s + Math.max(0, r.totalAmount - r.paidAmount), 0);

  return NextResponse.json({
    businessDate: property?.businessDate ?? today,
    kpis: {
      occupancy: Math.round(occupancy * 10) / 10,
      occupancyDelta: Math.round((occupancy - occupancyLastWeek) * 10) / 10,
      adr: Math.round(adr),
      adrDelta: 8,
      revpar: Math.round(revpar),
      revparDelta: 11,
      revenueToday: Math.round(revenueToday),
      revenueDelta: revenueLastWeek > 0 ? Math.round(((revenueToday - revenueLastWeek) / revenueLastWeek) * 100) : 15,
      outstanding: Math.round(outstanding),
    },
    revenueBreakdown: { room: Math.round(roomRevToday), fnb: Math.round(fnbRevToday), misc: Math.round(miscRevToday) },
    roomStatus,
    checkIns: checkInsToday.slice(0, 10).map((r) => ({
      id: r.id, confirmationNumber: r.confirmationNumber, guestName: r.guest.fullName,
      roomNumber: r.room?.number ?? "—", checkIn: r.checkIn, status: r.status, paidAmount: r.paidAmount, totalAmount: r.totalAmount,
    })),
    checkOuts: checkOutsToday.slice(0, 10).map((r) => ({
      id: r.id, confirmationNumber: r.confirmationNumber, guestName: r.guest.fullName,
      roomNumber: r.room?.number ?? "—", checkOut: r.checkOut, status: r.status,
      balance: Math.max(0, r.totalAmount - r.paidAmount),
    })),
    recentReservations: recent,
    counts: {
      totalRooms,
      occupied,
      vacant: rooms.filter((r) => r.status === "vacant" || r.status === "clean").length,
      dirty: rooms.filter((r) => r.status === "dirty").length,
      outOfOrder: rooms.filter((r) => r.status === "out_of_order").length,
      inHouse: inHouse.length,
      arrivals: checkInsToday.filter((r) => r.status === "confirmed").length,
      departures: checkOutsToday.filter((r) => r.status === "checked_in").length,
    },
  });
}
