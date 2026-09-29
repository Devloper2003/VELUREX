import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

/** GET /api/rate-plans — list rate plans with room type info. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const plans = await db.ratePlan.findMany({
    where: { propertyId },
    include: { roomType: { select: { id: true, name: true, code: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ ratePlans: plans });
}

/** POST /api/rate-plans — create a rate plan (hotel_admin). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim().toUpperCase();
  const baseRate = Number(body.baseRate);
  if (!name) return NextResponse.json({ error: "Plan name is required" }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Plan code is required" }, { status: 400 });
  if (Number.isNaN(baseRate) || baseRate <= 0)
    return NextResponse.json({ error: "Base rate must be a positive number" }, { status: 400 });

  let roomTypeId: string | null = body.roomTypeId ? String(body.roomTypeId) : null;
  if (roomTypeId) {
    const rt = await db.roomType.findFirst({ where: { id: roomTypeId, propertyId } });
    if (!rt) return NextResponse.json({ error: "Room type not found" }, { status: 404 });
  }

  const weekendRate = body.weekendRate === undefined || body.weekendRate === null || body.weekendRate === "" ? null : Number(body.weekendRate);
  const seasonalRate = body.seasonalRate === undefined || body.seasonalRate === null || body.seasonalRate === "" ? null : Number(body.seasonalRate);
  if (weekendRate !== null && (Number.isNaN(weekendRate) || weekendRate <= 0))
    return NextResponse.json({ error: "Weekend rate must be a positive number" }, { status: 400 });
  if (seasonalRate !== null && (Number.isNaN(seasonalRate) || seasonalRate <= 0))
    return NextResponse.json({ error: "Seasonal rate must be a positive number" }, { status: 400 });

  let seasonalStart: Date | null = null;
  let seasonalEnd: Date | null = null;
  if (body.seasonalStart) {
    seasonalStart = new Date(body.seasonalStart);
    if (Number.isNaN(seasonalStart.getTime())) return NextResponse.json({ error: "Invalid seasonal start date" }, { status: 400 });
  }
  if (body.seasonalEnd) {
    seasonalEnd = new Date(body.seasonalEnd);
    if (Number.isNaN(seasonalEnd.getTime())) return NextResponse.json({ error: "Invalid seasonal end date" }, { status: 400 });
  }
  if ((seasonalStart && !seasonalEnd) || (!seasonalStart && seasonalEnd))
    return NextResponse.json({ error: "Both seasonal start and end dates are required" }, { status: 400 });
  if (seasonalStart && seasonalEnd && seasonalEnd < seasonalStart)
    return NextResponse.json({ error: "Seasonal end date must be after the start date" }, { status: 400 });

  const plan = await db.ratePlan.create({
    data: {
      propertyId,
      name,
      code,
      description: String(body.description ?? ""),
      roomTypeId,
      baseRate,
      weekendRate,
      seasonalStart,
      seasonalEnd,
      seasonalRate,
      inclusions: String(body.inclusions ?? ""),
      active: body.active === undefined ? true : Boolean(body.active),
    },
    include: { roomType: { select: { id: true, name: true, code: true } } },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "RATE_PLAN_CREATE",
    entity: "RatePlan",
    entityId: plan.id,
    details: `Created rate plan ${name} (${code}) at ₹${baseRate}/night`,
  });

  return NextResponse.json({ ratePlan: plan }, { status: 201 });
}
