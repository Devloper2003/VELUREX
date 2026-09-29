import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/owner/coupons/[id] — toggle active / edit limits. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const coupon = await db.coupon.findUnique({ where: { id } });
  if (!coupon) return NextResponse.json({ error: "Coupon not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));

  if (body.action === "toggle") {
    const active = !coupon.active;
    await db.coupon.update({ where: { id }, data: { active } });
    await logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: "COUPON_UPDATED",
      entity: "coupon", entityId: id, details: `${coupon.code} ${active ? "activated" : "deactivated"}`,
    });
    return NextResponse.json({ ok: true, active });
  }

  const data: Record<string, unknown> = {};
  if (body.maxUses !== undefined) data.maxUses = Math.max(1, parseInt(String(body.maxUses), 10) || 100);
  if (body.validTo !== undefined) data.validTo = body.validTo ? new Date(body.validTo) : null;
  if (body.discountValue !== undefined) data.discountValue = Math.max(0, Number(body.discountValue));
  if (body.description !== undefined) data.description = String(body.description);
  await db.coupon.update({ where: { id }, data });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "COUPON_UPDATED",
    entity: "coupon", entityId: id, details: `${coupon.code} edited`,
  });
  return NextResponse.json({ ok: true });
}

/** DELETE /api/owner/coupons/[id] — hard delete only when unused. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const coupon = await db.coupon.findUnique({ where: { id }, include: { redemptions: true } });
  if (!coupon) return NextResponse.json({ error: "Coupon not found" }, { status: 404 });
  if (coupon.redemptions.length > 0 || coupon.usedCount > 0) {
    return NextResponse.json({ error: "Coupon has redemptions — deactivate it instead" }, { status: 400 });
  }
  await db.coupon.delete({ where: { id } });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "COUPON_DELETED",
    entity: "coupon", entityId: id, details: `${coupon.code} deleted`,
  });
  return NextResponse.json({ ok: true });
}
