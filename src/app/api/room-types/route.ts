import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

/** GET /api/room-types — list room types with room counts. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const roomTypes = await db.roomType.findMany({
    where: { propertyId },
    include: { _count: { select: { rooms: true } } },
    orderBy: { baseRate: "asc" },
  });

  return NextResponse.json({
    roomTypes: roomTypes.map((t) => ({
      ...t,
      amenities: JSON.parse(t.amenities || "[]") as string[],
    })),
  });
}

/** POST /api/room-types — create a room type (hotel_admin, front_desk). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim().toUpperCase();
  const baseRate = Number(body.baseRate);
  const maxOccupancy = Number(body.maxOccupancy ?? 2);

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Code is required" }, { status: 400 });
  if (Number.isNaN(baseRate) || baseRate <= 0)
    return NextResponse.json({ error: "Base rate must be a positive number" }, { status: 400 });
  if (Number.isNaN(maxOccupancy) || maxOccupancy < 1)
    return NextResponse.json({ error: "Max occupancy must be at least 1" }, { status: 400 });

  const dupe = await db.roomType.findFirst({ where: { propertyId, code } });
  if (dupe) return NextResponse.json({ error: `Room type code "${code}" already exists` }, { status: 409 });

  const amenities: string[] = Array.isArray(body.amenities)
    ? body.amenities.map((a: unknown) => String(a)).filter(Boolean)
    : typeof body.amenities === "string" && body.amenities.trim()
      ? body.amenities.split(",").map((a: string) => a.trim()).filter(Boolean)
      : [];

  const roomType = await db.roomType.create({
    data: {
      propertyId,
      name,
      code,
      baseRate,
      maxOccupancy,
      sizeSqft: Number(body.sizeSqft ?? 250) || 250,
      bedType: String(body.bedType ?? "King"),
      amenities: JSON.stringify(amenities),
      description: String(body.description ?? ""),
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ROOM_TYPE_CREATE",
    entity: "RoomType",
    entityId: roomType.id,
    details: `Created room type ${name} (${code}) at ₹${baseRate}/night`,
  });

  return NextResponse.json({ roomType: { ...roomType, amenities } }, { status: 201 });
}
