import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/** GET — list all promo codes (admin / front desk). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;

  const promos = await db.promoCode.findMany({
    where: { propertyId: auth.session.propertyId },
    orderBy: { validFrom: "desc" },
  });
  return NextResponse.json({ promos });
}

/** POST — create a promo code (admin only). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  try {
    const body = await req.json();
    const code = String(body.code || "").trim().toUpperCase();
    const discountType = body.discountType === "flat" ? "flat" : "percent";
    const discountValue = Number(body.discountValue);
    const validFrom = body.validFrom ? new Date(body.validFrom) : new Date();
    // Schema requires a non-null validTo — default to a 90-day window
    const validTo = body.validTo ? new Date(body.validTo) : new Date(Date.now() + 90 * 86400000);
    const maxUses = Math.max(1, Number(body.maxUses) || 100);

    if (!code || code.length < 3 || code.length > 24) {
      return NextResponse.json({ error: "Code must be 3–24 characters" }, { status: 400 });
    }
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      return NextResponse.json({ error: "Code may only contain letters, numbers, - and _" }, { status: 400 });
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return NextResponse.json({ error: "Discount value must be positive" }, { status: 400 });
    }
    if (discountType === "percent" && discountValue > 100) {
      return NextResponse.json({ error: "Percent discount cannot exceed 100%" }, { status: 400 });
    }
    if (validTo && validTo < validFrom) {
      return NextResponse.json({ error: "Valid-to date must be after valid-from" }, { status: 400 });
    }

    const exists = await db.promoCode.findUnique({ where: { code } });
    if (exists) return NextResponse.json({ error: `Code ${code} already exists` }, { status: 409 });

    const promo = await db.promoCode.create({
      data: {
        propertyId: auth.session.propertyId,
        code,
        description: String(body.description || "").slice(0, 200),
        discountType,
        discountValue,
        validFrom,
        validTo,
        maxUses,
      },
    });

    await logActivity({
      propertyId: auth.session.propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "PROMO_CREATE",
      entity: "promo_code",
      entityId: promo.id,
      details: `Created promo ${code} (${discountType === "percent" ? `${discountValue}%` : `₹${discountValue}`} off)`,
    });

    return NextResponse.json({ promo }, { status: 201 });
  } catch (e) {
    console.error("promo create error", e);
    return NextResponse.json({ error: "Failed to create promo code" }, { status: 500 });
  }
}
