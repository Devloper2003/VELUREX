import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/owner/plans/[id] — edit plan (name, price, features JSON, active…). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const plan = await db.plan.findUnique({ where: { id } });
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = String(body.name);
  if (body.description !== undefined) data.description = String(body.description);
  if (body.monthlyPrice !== undefined) data.monthlyPrice = Math.max(0, Number(body.monthlyPrice));
  if (body.features !== undefined) data.features = JSON.stringify(body.features);
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);
  if (body.active !== undefined) data.active = Boolean(body.active);

  const updated = await db.plan.update({ where: { id }, data });

  // Price/feature changes affect every subscriber → clear the entitlements cache.
  await clearEntitlementsCache();

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "PLAN_UPDATED",
    entity: "plan", entityId: id,
    details: `Plan ${updated.name} updated${body.monthlyPrice !== undefined ? ` — price now ₹${updated.monthlyPrice}/mo` : ""}${body.features !== undefined ? " — features edited" : ""}`,
  });

  return NextResponse.json({ ok: true });
}
