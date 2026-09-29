import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { getTenantEntitlements, requireFeature } from "@/lib/entitlements";

/**
 * POST /api/pricing/apply — auth (hotel_admin): push a suggested rate onto a
 * room type's baseRate. Takes effect immediately in the booking engine quote
 * and front-desk reservation defaults.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: dynamic pricing is an Enterprise feature.
  const ent = await getTenantEntitlements(propertyId);
  const locked = requireFeature(ent, "dynamic_pricing", "Dynamic Pricing");
  if (locked) return locked;

  const body = (await req.json().catch(() => null)) as { roomTypeId?: string; newRate?: number } | null;
  const newRate = Number(body?.newRate);
  if (!body?.roomTypeId)
    return NextResponse.json({ error: "roomTypeId is required" }, { status: 400 });
  if (!Number.isFinite(newRate) || newRate <= 0)
    return NextResponse.json({ error: "newRate must be a positive number" }, { status: 400 });

  const roomType = await db.roomType.findFirst({ where: { id: body.roomTypeId, propertyId } });
  if (!roomType) return NextResponse.json({ error: "Room type not found" }, { status: 404 });

  const updated = await db.roomType.update({
    where: { id: roomType.id },
    data: { baseRate: Math.round(newRate * 100) / 100 },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "RATE_APPLIED",
    entity: "RoomType",
    entityId: roomType.id,
    details: `Base rate for ${roomType.name} (${roomType.code}) set to ₹${updated.baseRate} (was ₹${roomType.baseRate})`,
  });

  return NextResponse.json({ roomType: updated });
}
