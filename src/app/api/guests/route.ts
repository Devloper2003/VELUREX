import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

const STAY_STATUSES = ["checked_in", "checked_out"];

/** GET /api/guests?search= — guest directory with stay aggregates. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.trim();

  const guests = await db.guest.findMany({
    where: {
      propertyId,
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { fullName: "asc" },
  });

  const reservations = await db.reservation.findMany({
    where: { propertyId, guestId: { in: guests.map((g) => g.id) }, status: { in: STAY_STATUSES } },
    select: { guestId: true, checkOut: true },
    orderBy: { checkOut: "desc" },
  });

  const staysByGuest = new Map<string, { totalStays: number; lastStayAt: Date | null }>();
  for (const res of reservations) {
    const agg = staysByGuest.get(res.guestId) ?? { totalStays: 0, lastStayAt: null };
    agg.totalStays += 1;
    if (!agg.lastStayAt || res.checkOut > agg.lastStayAt) agg.lastStayAt = res.checkOut;
    staysByGuest.set(res.guestId, agg);
  }

  return NextResponse.json({
    guests: guests.map((g) => ({
      ...g,
      totalStays: staysByGuest.get(g.id)?.totalStays ?? 0,
      lastStayAt: staysByGuest.get(g.id)?.lastStayAt ?? null,
    })),
  });
}

/** POST /api/guests — create a guest profile (hotel_admin, front_desk). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const fullName = String(body.fullName ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  if (!fullName) return NextResponse.json({ error: "Guest name is required" }, { status: 400 });
  if (!phone) return NextResponse.json({ error: "Phone number is required" }, { status: 400 });

  const guest = await db.guest.create({
    data: {
      propertyId,
      fullName,
      phone,
      email: String(body.email ?? ""),
      idType: String(body.idType ?? ""),
      idNumber: String(body.idNumber ?? ""),
      address: String(body.address ?? ""),
      city: String(body.city ?? ""),
      nationality: String(body.nationality ?? "Indian"),
      photoUrl: String(body.photoUrl ?? ""),
      notes: String(body.notes ?? ""),
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GUEST_CREATE",
    entity: "Guest",
    entityId: guest.id,
    details: `Created guest profile for ${fullName} (${phone})`,
  });

  return NextResponse.json({ guest }, { status: 201 });
}
