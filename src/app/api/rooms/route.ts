import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";
import { getTenantEntitlements, assertWritable, checkLimit } from "@/lib/entitlements";

const ROOM_STATUSES = ["vacant", "occupied", "dirty", "clean", "out_of_order"];

/** GET /api/rooms — list rooms (filter: status, floor, search by number). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const floorParam = searchParams.get("floor");
  const search = searchParams.get("search")?.trim();

  const where: Record<string, unknown> = { propertyId };
  if (status) where.status = status;
  if (floorParam && !Number.isNaN(Number(floorParam))) where.floor = Number(floorParam);
  if (search) where.number = { contains: search, mode: "insensitive" };

  const rooms = await db.room.findMany({
    where,
    include: {
      roomType: true,
      reservations: {
        where: { status: "checked_in" },
        orderBy: { checkedInAt: "desc" },
        take: 1,
        select: {
          id: true,
          confirmationNumber: true,
          checkIn: true,
          checkOut: true,
          guest: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
    orderBy: [{ floor: "asc" }, { number: "asc" }],
  });

  return NextResponse.json({
    rooms: rooms.map((r) => ({
      id: r.id,
      number: r.number,
      floor: r.floor,
      status: r.status,
      note: r.note,
      roomType: { id: r.roomType.id, name: r.roomType.name, code: r.roomType.code, baseRate: r.roomType.baseRate },
      currentReservation: r.reservations[0]
        ? {
            id: r.reservations[0].id,
            confirmationNumber: r.reservations[0].confirmationNumber,
            checkIn: r.reservations[0].checkIn,
            checkOut: r.reservations[0].checkOut,
            guest: r.reservations[0].guest,
          }
        : null,
    })),
  });
}

/** POST /api/rooms — create a room (hotel_admin, front_desk). Enforces plan room limits. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: workspace must be writable and under the rooms cap.
  const ent = await getTenantEntitlements(propertyId);
  const ro = assertWritable(ent);
  if (ro) return ro;
  const roomCount = await db.room.count({ where: { propertyId } });
  const capped = checkLimit(ent, "rooms", roomCount, "rooms");
  if (capped) return capped;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const number = String(body.number ?? "").trim();
  const floor = Number(body.floor);
  const roomTypeId = String(body.roomTypeId ?? "");
  const status = body.status ? String(body.status) : "vacant";

  if (!number) return NextResponse.json({ error: "Room number is required" }, { status: 400 });
  if (Number.isNaN(floor) || floor < 0) return NextResponse.json({ error: "A valid floor is required" }, { status: 400 });
  if (!ROOM_STATUSES.includes(status))
    return NextResponse.json({ error: `Status must be one of: ${ROOM_STATUSES.join(", ")}` }, { status: 400 });

  const roomType = await db.roomType.findFirst({ where: { id: roomTypeId, propertyId } });
  if (!roomType) return NextResponse.json({ error: "Room type not found" }, { status: 404 });

  const existing = await db.room.findFirst({ where: { propertyId, number } });
  if (existing)
    return NextResponse.json({ error: `Room ${number} already exists on this property` }, { status: 409 });

  const room = await db.room.create({
    data: { propertyId, number, floor, roomTypeId, status },
    include: { roomType: true },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_CREATE",
    entity: "Room",
    entityId: room.id,
    details: `Created room ${number} (floor ${floor}, ${roomType.name})`,
  });

  return NextResponse.json({ room }, { status: 201 });
}
