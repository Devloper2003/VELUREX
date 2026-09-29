import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

type RouteCtx = { params: Promise<{ id: string }> };

/** PATCH /api/rate-plans/[id] — update a rate plan (hotel_admin). */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const plan = await db.ratePlan.findFirst({ where: { id, propertyId } });
  if (!plan) return NextResponse.json({ error: "Rate plan not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Plan name cannot be empty" }, { status: 400 });
    data.name = name;
  }
  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase();
    if (!code) return NextResponse.json({ error: "Plan code cannot be empty" }, { status: 400 });
    data.code = code;
  }
  if (body.description !== undefined) data.description = String(body.description);
  if (body.inclusions !== undefined) data.inclusions = String(body.inclusions);
  if (body.active !== undefined) data.active = Boolean(body.active);

  if (body.roomTypeId !== undefined) {
    if (body.roomTypeId === null || body.roomTypeId === "") {
      data.roomTypeId = null;
    } else {
      const rt = await db.roomType.findFirst({ where: { id: String(body.roomTypeId), propertyId } });
      if (!rt) return NextResponse.json({ error: "Room type not found" }, { status: 404 });
      data.roomTypeId = rt.id;
    }
  }

  if (body.baseRate !== undefined) {
    const baseRate = Number(body.baseRate);
    if (Number.isNaN(baseRate) || baseRate <= 0)
      return NextResponse.json({ error: "Base rate must be a positive number" }, { status: 400 });
    data.baseRate = baseRate;
  }
  if (body.weekendRate !== undefined) {
    data.weekendRate = body.weekendRate === null || body.weekendRate === "" ? null : Number(body.weekendRate);
    if (data.weekendRate !== null && (Number.isNaN(data.weekendRate as number) || (data.weekendRate as number) <= 0))
      return NextResponse.json({ error: "Weekend rate must be a positive number" }, { status: 400 });
  }
  if (body.seasonalRate !== undefined) {
    data.seasonalRate = body.seasonalRate === null || body.seasonalRate === "" ? null : Number(body.seasonalRate);
    if (data.seasonalRate !== null && (Number.isNaN(data.seasonalRate as number) || (data.seasonalRate as number) <= 0))
      return NextResponse.json({ error: "Seasonal rate must be a positive number" }, { status: 400 });
  }
  if (body.seasonalStart !== undefined) {
    data.seasonalStart = body.seasonalStart ? new Date(body.seasonalStart) : null;
    if (data.seasonalStart instanceof Date && Number.isNaN(data.seasonalStart.getTime()))
      return NextResponse.json({ error: "Invalid seasonal start date" }, { status: 400 });
  }
  if (body.seasonalEnd !== undefined) {
    data.seasonalEnd = body.seasonalEnd ? new Date(body.seasonalEnd) : null;
    if (data.seasonalEnd instanceof Date && Number.isNaN(data.seasonalEnd.getTime()))
      return NextResponse.json({ error: "Invalid seasonal end date" }, { status: 400 });
  }

  const updated = await db.ratePlan.update({ where: { id }, data, include: { roomType: { select: { id: true, name: true, code: true } } } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "RATE_PLAN_UPDATE",
    entity: "RatePlan",
    entityId: id,
    details: `Updated rate plan ${updated.name} (${updated.code})${body.active !== undefined ? ` — ${updated.active ? "activated" : "deactivated"}` : ""}`,
  });

  return NextResponse.json({ ratePlan: updated });
}

/** DELETE /api/rate-plans/[id] — delete a rate plan (hotel_admin). Detaches reservations first. */
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const plan = await db.ratePlan.findFirst({ where: { id, propertyId } });
  if (!plan) return NextResponse.json({ error: "Rate plan not found" }, { status: 404 });

  await db.reservation.updateMany({ where: { ratePlanId: id }, data: { ratePlanId: null } });
  await db.ratePlan.delete({ where: { id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "RATE_PLAN_DELETE",
    entity: "RatePlan",
    entityId: id,
    details: `Deleted rate plan ${plan.name} (${plan.code})`,
  });

  return NextResponse.json({ ok: true });
}
