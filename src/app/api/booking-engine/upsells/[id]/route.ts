import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * PATCH/DELETE /api/booking-engine/upsells/[id] — manage a single add-on.
 * PATCH: any of name / description / price / priceType / active / sortOrder.
 * DELETE: remove it outright (guests can no longer select it on new holds).
 */

const PRICE_TYPES = new Set(["flat", "per_night", "per_guest"]);

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const existing = await db.bookingUpsell.findFirst({ where: { id, propertyId } });
  if (!existing) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: {
    name?: string;
    description?: string;
    price?: number;
    priceType?: string;
    active?: boolean;
    sortOrder?: number;
  } = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 1 || name.length > 80) {
      return NextResponse.json({ error: "name must be between 1 and 80 characters" }, { status: 400 });
    }
    data.name = name;
  }
  if (body.description !== undefined) {
    const description = String(body.description).trim();
    if (description.length > 300) {
      return NextResponse.json({ error: "description must be at most 300 characters" }, { status: 400 });
    }
    data.description = description;
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json({ error: "price must be a positive number" }, { status: 400 });
    }
    data.price = Math.round(price * 100) / 100;
  }
  if (body.priceType !== undefined) {
    const priceType = String(body.priceType);
    if (!PRICE_TYPES.has(priceType)) {
      return NextResponse.json({ error: "priceType must be flat, per_night or per_guest" }, { status: 400 });
    }
    data.priceType = priceType;
  }
  if (typeof body.active === "boolean") data.active = body.active;
  if (body.sortOrder !== undefined) {
    const sortOrder = Number(body.sortOrder);
    if (!Number.isInteger(sortOrder)) {
      return NextResponse.json({ error: "sortOrder must be an integer" }, { status: 400 });
    }
    data.sortOrder = sortOrder;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const upsell = await db.bookingUpsell.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "UPSELL_UPDATE",
    entity: "BookingUpsell",
    entityId: id,
    details: `Updated add-on "${upsell.name}": ${Object.keys(data).join(", ")}`,
  });

  return NextResponse.json({ upsell });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const existing = await db.bookingUpsell.findFirst({ where: { id, propertyId } });
  if (!existing) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });

  await db.bookingUpsell.delete({ where: { id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "UPSELL_DELETE",
    entity: "BookingUpsell",
    entityId: id,
    details: `Deleted add-on "${existing.name}" (₹${existing.price} ${existing.priceType.replace("_", "-")})`,
  });

  return NextResponse.json({ ok: true });
}
