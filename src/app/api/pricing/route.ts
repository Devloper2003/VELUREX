import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const SUGGESTION_DAYS = 7;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * GET /api/pricing — dynamic pricing rule state, live occupancy and per-date
 * suggestions for the next 7 days (days whose projected occupancy crosses the
 * threshold get per-room-type rate suggestions).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const [property, rooms, roomTypes, futureReservations] = await Promise.all([
    db.property.findUnique({ where: { id: propertyId } }),
    db.room.findMany({ where: { propertyId }, select: { id: true, status: true } }),
    db.roomType.findMany({ where: { propertyId }, orderBy: { baseRate: "asc" } }),
    db.reservation.findMany({
      where: {
        propertyId,
        status: { in: ["confirmed", "checked_in"] },
        // anything that could overlap the next 7 days
        checkIn: { lt: new Date(Date.now() + (SUGGESTION_DAYS + 2) * 86400000) },
        checkOut: { gt: new Date() },
      },
      select: { checkIn: true, checkOut: true },
    }),
  ]);
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const totalRooms = rooms.length || 1;
  const occupied = rooms.filter((r) => r.status === "occupied").length;
  const occupancyNow = Math.round((occupied / totalRooms) * 1000) / 10;

  const rule = {
    enabled: property.pricingEnabled,
    occupancyThreshold: property.occupancyThreshold,
    rateIncreasePercent: property.rateIncreasePercent,
  };

  // Night-by-night projected occupancy for tomorrow … +7 days.
  const suggestions: {
    date: string;
    occupancyProjected: number;
    baseRates: { roomTypeId: string; roomTypeName: string; currentBase: number; suggested: number }[];
  }[] = [];

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  for (let i = 1; i <= SUGGESTION_DAYS; i++) {
    const day = midnight(new Date(Date.now() + i * 86400000));
    const nightEnd = new Date(day.getTime() + 86400000);
    const overlapping = futureReservations.filter((r) => r.checkIn < nightEnd && r.checkOut > day).length;
    const projected = Math.round((overlapping / totalRooms) * 1000) / 10;

    if (projected >= rule.occupancyThreshold) {
      suggestions.push({
        date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
        occupancyProjected: projected,
        baseRates: roomTypes.map((rt) => ({
          roomTypeId: rt.id,
          roomTypeName: rt.name,
          currentBase: rt.baseRate,
          suggested: round2(rt.baseRate * (1 + rule.rateIncreasePercent / 100)),
        })),
      });
    }
  }

  const activeNow = rule.enabled && occupancyNow >= rule.occupancyThreshold;
  const message = !rule.enabled
    ? "Auto pricing is off — suggestions below are informational only."
    : suggestions.length > 0
      ? `Projected occupancy crosses ${rule.occupancyThreshold}% on ${suggestions.length} of the next ${SUGGESTION_DAYS} days — consider raising rates by ${rule.rateIncreasePercent}%.`
      : `No day in the next ${SUGGESTION_DAYS} days crosses the ${rule.occupancyThreshold}% occupancy threshold — hold current rates.`;

  return NextResponse.json({
    rule: { ...rule, activeNow },
    occupancyNow,
    totalRooms: rooms.length,
    occupiedRooms: occupied,
    suggestions,
    message,
  });
}

/**
 * PUT /api/pricing — auth (hotel_admin): update the dynamic pricing rule on
 * the property.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as
    | { enabled?: boolean; occupancyThreshold?: number; rateIncreasePercent?: number }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: { pricingEnabled?: boolean; occupancyThreshold?: number; rateIncreasePercent?: number } = {};
  if (typeof body.enabled === "boolean") data.pricingEnabled = body.enabled;
  if (body.occupancyThreshold !== undefined) {
    const t = Number(body.occupancyThreshold);
    if (!Number.isFinite(t) || t < 1 || t > 100)
      return NextResponse.json({ error: "occupancyThreshold must be between 1 and 100" }, { status: 400 });
    data.occupancyThreshold = t;
  }
  if (body.rateIncreasePercent !== undefined) {
    const r = Number(body.rateIncreasePercent);
    if (!Number.isFinite(r) || r < 0 || r > 100)
      return NextResponse.json({ error: "rateIncreasePercent must be between 0 and 100" }, { status: 400 });
    data.rateIncreasePercent = r;
  }

  if (Object.keys(data).length === 0)
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const property = await db.property.update({ where: { id: propertyId }, data });

  await logActivitySafe(propertyId, auth.session, data);

  return NextResponse.json({
    rule: {
      enabled: property.pricingEnabled,
      occupancyThreshold: property.occupancyThreshold,
      rateIncreasePercent: property.rateIncreasePercent,
    },
  });
}

async function logActivitySafe(
  propertyId: string,
  session: { sub: string; name: string },
  data: { pricingEnabled?: boolean; occupancyThreshold?: number; rateIncreasePercent?: number }
) {
  const parts: string[] = [];
  if (data.pricingEnabled !== undefined) parts.push(`rule ${data.pricingEnabled ? "enabled" : "disabled"}`);
  if (data.occupancyThreshold !== undefined) parts.push(`threshold ${data.occupancyThreshold}%`);
  if (data.rateIncreasePercent !== undefined) parts.push(`increase ${data.rateIncreasePercent}%`);
  await logActivity({
    propertyId,
    staffId: session.sub,
    staffName: session.name,
    action: "PRICING_UPDATE",
    entity: "Property",
    entityId: propertyId,
    details: parts.join(" · "),
  });
}
