import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * GET/POST /api/booking-engine/upsells — booking-engine add-ons
 * (Airport pickup, Early check-in, Breakfast buffet…).
 *
 * GET  (hotel_admin): all upsells ordered by sortOrder.
 * POST (hotel_admin): { name, description?, price, priceType, active?, sortOrder? }
 * priceType: "flat" | "per_night" | "per_guest".
 */

const PRICE_TYPES = new Set(["flat", "per_night", "per_guest"]);

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  const upsells = await db.bookingUpsell.findMany({
    where: { propertyId: auth.session.propertyId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ upsells });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: "name must be between 1 and 80 characters" }, { status: 400 });
  }

  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (description.length > 300) {
    return NextResponse.json({ error: "description must be at most 300 characters" }, { status: 400 });
  }

  const price = Number(body?.price);
  if (!Number.isFinite(price) || price <= 0) {
    return NextResponse.json({ error: "price must be a positive number" }, { status: 400 });
  }

  const priceType = typeof body?.priceType === "string" && PRICE_TYPES.has(body.priceType)
    ? body.priceType
    : "flat";
  const active = typeof body?.active === "boolean" ? body.active : true;
  const sortOrder = Number.isInteger(Number(body?.sortOrder)) ? Number(body?.sortOrder) : 0;

  const upsell = await db.bookingUpsell.create({
    data: {
      propertyId,
      name,
      description,
      price: Math.round(price * 100) / 100,
      priceType,
      active,
      sortOrder,
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "UPSELL_CREATE",
    entity: "BookingUpsell",
    entityId: upsell.id,
    details: `Added add-on "${name}" — ₹${upsell.price} ${priceType.replace("_", "-")}`,
  });

  return NextResponse.json({ upsell }, { status: 201 });
}
