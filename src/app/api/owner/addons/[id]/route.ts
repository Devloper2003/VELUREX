import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { logPlatformAction } from "@/lib/platform";
import { stringifyGrants } from "@/lib/feature-catalog";

type Params = { params: Promise<{ id: string }> };

/** Accepts grants as an object or a pre-serialized JSON string. */
function normalizeGrantsInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try { return JSON.parse(input) as Record<string, unknown>; } catch { return {}; }
  }
  return ((input ?? {}) as Record<string, unknown>);
}

/**
 * PATCH  /api/owner/addons/[id] — edit a catalogue add-on (price, grants, plans, badge, active…).
 * DELETE /api/owner/addons/[id] — remove from catalogue. If tenants have purchased it,
 *                                the row is deactivated instead of deleted (billing history).
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const addon = await db.addonCatalog.findUnique({ where: { id } });
  if (!addon) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    data.name = name;
  }
  if (body.description !== undefined) data.description = String(body.description).slice(0, 500);
  if (body.category !== undefined && ["feature", "capacity", "service"].includes(String(body.category)))
    data.category = String(body.category);
  if (body.price !== undefined) data.price = Math.max(0, Number(body.price));
  if (body.oneOff !== undefined) data.oneOff = Boolean(body.oneOff);
  if (body.grants !== undefined) data.grants = stringifyGrants(normalizeGrantsInput(body.grants));
  if (body.planCodes !== undefined)
    data.planCodes = JSON.stringify(Array.isArray(body.planCodes) ? body.planCodes.map(String).filter(Boolean) : []);
  if (body.badge !== undefined) data.badge = String(body.badge).slice(0, 30);
  if (body.icon !== undefined) data.icon = String(body.icon).slice(0, 40);
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);
  if (body.active !== undefined) data.active = Boolean(body.active);

  const updated = await db.addonCatalog.update({ where: { id }, data });

  // Grants/price/active changes affect every holder → clear entitlements cache.
  await clearEntitlementsCache();

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ADDON_UPDATED",
    entity: "addon_catalog", entityId: id,
    details: `Add-on ${updated.name} updated${body.price !== undefined ? ` — price now ₹${updated.price}${updated.oneOff ? " one-off" : "/mo"}` : ""}${body.grants !== undefined ? " — grants edited" : ""}${body.active !== undefined ? ` — ${updated.active ? "activated" : "deactivated"}` : ""}`,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const addon = await db.addonCatalog.findUnique({ where: { id } });
  if (!addon) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });

  const purchases = await db.subscriptionAddon.count({ where: { addonKey: addon.key } });
  if (purchases > 0) {
    // Soft-disable — keep entitlements + billing history consistent.
    await db.addonCatalog.update({ where: { id }, data: { active: false } });
    await clearEntitlementsCache();
    await logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: "ADDON_DISABLED",
      entity: "addon_catalog", entityId: id,
      details: `Add-on ${addon.name} deactivated (${purchases} active purchases kept)`,
    });
    return NextResponse.json({ ok: true, deactivated: true, purchases });
  }

  await db.addonCatalog.delete({ where: { id } });
  await clearEntitlementsCache();
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ADDON_DELETED",
    entity: "addon_catalog", entityId: id, details: `Add-on ${addon.name} deleted`,
  });
  return NextResponse.json({ ok: true, deleted: true });
}
