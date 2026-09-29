import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";
import { demoScope, notDemoPlatform, notDemoTenant } from "@/lib/owner-demo";

/** GET /api/owner/coupons — coupons + redemption counts. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const coupons = await db.coupon.findMany({
    where: notDemoPlatform(scope),
    orderBy: { createdAt: "desc" },
    include: { redemptions: { where: notDemoTenant(scope), include: { property: { select: { name: true } } } } },
  });

  return NextResponse.json({
    coupons: coupons.map((c) => ({
      id: c.id, code: c.code, description: c.description,
      discountType: c.discountType, discountValue: c.discountValue,
      maxUses: c.maxUses, usedCount: c.usedCount,
      validFrom: c.validFrom, validTo: c.validTo,
      planCode: c.planCode, trialDays: c.trialDays, active: c.active,
      redemptions: c.redemptions.map((r) => ({ at: r.createdAt, property: r.property?.name ?? "—" })),
    })),
  });
}

/** POST /api/owner/coupons — create coupon. */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const code = String(body.code ?? "").toUpperCase().trim();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code))
    return NextResponse.json({ error: "Code must be 3-24 chars (A-Z, 0-9, - or _)" }, { status: 400 });

  const exists = await db.coupon.findUnique({ where: { code } });
  if (exists) return NextResponse.json({ error: `Coupon ${code} already exists` }, { status: 409 });

  const discountType = ["percent", "flat"].includes(String(body.discountType)) ? String(body.discountType) : "percent";
  const trialDays = Math.max(0, parseInt(String(body.trialDays ?? "0"), 10) || 0);

  const coupon = await db.coupon.create({
    data: {
      code,
      description: String(body.description ?? ""),
      discountType,
      discountValue: Math.max(0, Number(body.discountValue ?? 0)),
      maxUses: Math.max(1, parseInt(String(body.maxUses ?? "100"), 10) || 100),
      validFrom: body.validFrom ? new Date(body.validFrom) : new Date(),
      validTo: body.validTo ? new Date(body.validTo) : null,
      planCode: String(body.planCode ?? ""),
      trialDays,
      active: true,
    },
  });

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "COUPON_CREATED",
    entity: "coupon", entityId: coupon.id,
    details: `${code}: ${trialDays > 0 ? `+${trialDays} trial days` : `${discountType === "percent" ? `${coupon.discountValue}%` : `₹${coupon.discountValue}`} off`}`,
  });

  return NextResponse.json({ ok: true, id: coupon.id }, { status: 201 });
}
