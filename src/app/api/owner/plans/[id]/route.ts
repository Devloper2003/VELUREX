import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { PLAN_CORE_SELECT, findPlanSafe, isSchemaGapError } from "@/lib/plan-safe";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/owner/plans/[id] — edit plan (name, price, features JSON, active…). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const plan = await findPlanSafe(id);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    data.name = name;
  }
  if (body.description !== undefined) data.description = String(body.description).slice(0, 500);
  if (body.tagline !== undefined) data.tagline = String(body.tagline).slice(0, 160);
  if (body.badge !== undefined) data.badge = String(body.badge).slice(0, 30);
  if (body.monthlyPrice !== undefined) data.monthlyPrice = Math.max(0, Number(body.monthlyPrice));
  if (body.features !== undefined) data.features = JSON.stringify(body.features);
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);
  if (body.active !== undefined) data.active = Boolean(body.active);

  // Explicit core select on the fallback keeps the Prisma read-back safe on
  // pre-v2.3.0 databases (no tagline/badge columns to read). tagline/badge
  // edits are silently skipped there — core fields still apply.
  let updated;
  try {
    updated = await db.plan.update({ where: { id }, data });
  } catch (err) {
    if (!isSchemaGapError(err)) throw err;
    const { tagline: _t, badge: _b, ...core } = data as Record<string, unknown>;
    updated = await db.plan.update({ where: { id }, data: core, select: PLAN_CORE_SELECT });
  }

  // Price/feature changes affect every subscriber → clear the entitlements cache.
  await clearEntitlementsCache();

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "PLAN_UPDATED",
    entity: "plan", entityId: id,
    details: `Plan ${updated.name} updated${body.monthlyPrice !== undefined ? ` — price now ₹${updated.monthlyPrice}/mo` : ""}${body.features !== undefined ? " — features edited" : ""}`,
  });

  return NextResponse.json({ ok: true });
}
