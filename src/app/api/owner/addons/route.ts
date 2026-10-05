import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { logPlatformAction } from "@/lib/platform";
import { stringifyGrants } from "@/lib/feature-catalog";

/**
 * GET  /api/owner/addons — full add-on catalogue (active + inactive) with
 *                        purchase counts, for the platform console.
 * POST /api/owner/addons — create a catalogue add-on.
 *
 * Body: { key, name, description?, category, price, oneOff?, grants?, planCodes?, badge?, icon?, sortOrder?, active? }
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const rows = await db.addonCatalog.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const purchases = await db.subscriptionAddon.groupBy({
    by: ["addonKey"],
    _count: { _all: true },
    _sum: { qty: true },
  });
  const purchaseMap = new Map(purchases.map((p) => [p.addonKey, p]));

  return NextResponse.json({
    addons: rows.map((c) => {
      let grants: Record<string, unknown> = {};
      let planCodes: string[] = [];
      try { grants = JSON.parse(c.grants) as Record<string, unknown>; } catch { /* noop */ }
      try { planCodes = JSON.parse(c.planCodes) as string[]; } catch { /* noop */ }
      const p = purchaseMap.get(c.key);
      return {
        id: c.id, key: c.key, name: c.name, description: c.description, category: c.category,
        price: c.price, oneOff: c.oneOff, grants, planCodes, badge: c.badge, icon: c.icon,
        sortOrder: c.sortOrder, active: c.active,
        purchaseCount: p?._count._all ?? 0, totalQty: p?._sum.qty ?? 0,
      };
    }),
  });
}

const VALID_CATEGORIES = ["feature", "capacity", "service"];

/** Accepts grants as an object or a pre-serialized JSON string. */
function normalizeGrantsInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try { return JSON.parse(input) as Record<string, unknown>; } catch { return {}; }
  }
  return ((input ?? {}) as Record<string, unknown>);
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const key = String(body.key ?? "").toLowerCase().trim();
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (key && !/^[a-z0-9_-]+$/.test(key))
    return NextResponse.json({ error: "key must be lowercase alphanumeric (a-z, 0-9, _ -)" }, { status: 400 });
  const finalKey = key || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!finalKey) return NextResponse.json({ error: "Could not derive a key from the name" }, { status: 400 });

  const exists = await db.addonCatalog.findUnique({ where: { key: finalKey } });
  if (exists) return NextResponse.json({ error: `Add-on key "${finalKey}" already exists` }, { status: 409 });

  const category = VALID_CATEGORIES.includes(String(body.category)) ? String(body.category) : "feature";
  const price = Math.max(0, Number(body.price ?? 0));
  const planCodes: string[] = Array.isArray(body.planCodes) ? body.planCodes.map(String).filter(Boolean) : [];

  const addon = await db.addonCatalog.create({
    data: {
      key: finalKey,
      name,
      description: String(body.description ?? "").slice(0, 500),
      category,
      price,
      oneOff: body.oneOff === true || (category === "service" && body.oneOff !== false),
      grants: stringifyGrants(normalizeGrantsInput(body.grants)),
      planCodes: JSON.stringify(planCodes),
      badge: String(body.badge ?? "").slice(0, 30),
      icon: String(body.icon ?? "puzzle").slice(0, 40),
      sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 50,
      active: body.active !== false,
    },
  });

  await clearEntitlementsCache();
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ADDON_CREATED",
    entity: "addon_catalog", entityId: addon.id, details: `Add-on ${name} (${finalKey}) created — ₹${addon.price}${addon.oneOff ? " one-off" : "/mo"}`,
  });

  return NextResponse.json({ ok: true, id: addon.id }, { status: 201 });
}
