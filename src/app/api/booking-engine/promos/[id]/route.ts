import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

type Params = { params: Promise<{ id: string }> };

/** PATCH — update a promo code (admin only): toggle active, extend validity, change value/uses. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const existing = await db.promoCode.findFirst({ where: { id, propertyId: auth.session.propertyId } });
    if (!existing) return NextResponse.json({ error: "Promo code not found" }, { status: 404 });

    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (typeof body.active === "boolean") data.active = body.active;
    if (body.description !== undefined) data.description = String(body.description).slice(0, 200);
    if (body.maxUses !== undefined) {
      const maxUses = Number(body.maxUses);
      if (!Number.isFinite(maxUses) || maxUses < existing.usedCount) {
        return NextResponse.json({ error: `Max uses must be ≥ ${existing.usedCount} (already redeemed)` }, { status: 400 });
      }
      data.maxUses = Math.floor(maxUses);
    }
    if (body.discountValue !== undefined) {
      const v = Number(body.discountValue);
      if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ error: "Discount value must be positive" }, { status: 400 });
      if (existing.discountType === "percent" && v > 100) {
        return NextResponse.json({ error: "Percent discount cannot exceed 100%" }, { status: 400 });
      }
      data.discountValue = v;
    }
    if (body.validTo !== undefined) {
      const vt = new Date(body.validTo);
      if (Number.isNaN(vt.getTime())) {
        return NextResponse.json({ error: "Invalid valid-to date" }, { status: 400 });
      }
      if (vt < existing.validFrom) {
        return NextResponse.json({ error: "Valid-to must be after valid-from" }, { status: 400 });
      }
      data.validTo = vt;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const promo = await db.promoCode.update({ where: { id }, data });

    await logActivity({
      propertyId: auth.session.propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "PROMO_UPDATE",
      entity: "promo_code",
      entityId: promo.id,
      details: `Updated promo ${promo.code}: ${Object.keys(data).join(", ")}`,
    });

    return NextResponse.json({ promo });
  } catch (e) {
    console.error("promo patch error", e);
    return NextResponse.json({ error: "Failed to update promo code" }, { status: 500 });
  }
}

/** DELETE — permanently remove an unused promo code (admin only). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const existing = await db.promoCode.findFirst({ where: { id, propertyId: auth.session.propertyId } });
  if (!existing) return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  if (existing.usedCount > 0) {
    return NextResponse.json({ error: "Cannot delete a redeemed promo — deactivate it instead" }, { status: 409 });
  }

  await db.promoCode.delete({ where: { id } });
  await logActivity({
    propertyId: auth.session.propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "PROMO_DELETE",
    entity: "promo_code",
    entityId: id,
    details: `Deleted promo ${existing.code}`,
  });
  return NextResponse.json({ ok: true });
}
