import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const CATEGORIES = ["starter", "main", "dessert", "beverage", "bar"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** PATCH /api/menu/[id] — edit price/name/availability etc. Roles: hotel_admin, restaurant_staff. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const existing = await db.menuItem.findFirst({ where: { id, propertyId } });
  if (!existing) {
    return NextResponse.json({ error: "Menu item not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const data: {
    name?: string;
    price?: number;
    available?: boolean;
    category?: string;
    description?: string;
    taxRate?: number;
  } = {};

  const name = str(body.name);
  if (name) data.name = name;

  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json({ error: "price must be a positive number" }, { status: 400 });
    }
    data.price = Math.round(price * 100) / 100;
  }

  if (typeof body.available === "boolean") data.available = body.available;

  const category = str(body.category);
  if (category) {
    if (!CATEGORIES.includes(category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    data.category = category;
  }

  if (typeof body.description === "string") data.description = body.description.trim();

  if (body.taxRate !== undefined) {
    const taxRate = Number(body.taxRate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      return NextResponse.json({ error: "taxRate must be between 0 and 100" }, { status: 400 });
    }
    data.taxRate = taxRate;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const item = await db.menuItem.update({ where: { id }, data });

  const changed = Object.keys(data).join(", ");
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "MENU_ITEM_UPDATE",
    entity: "MenuItem",
    entityId: item.id,
    details: `${item.name}: ${changed}${data.available === false ? " → SOLD OUT" : data.available === true ? " → available" : ""}`,
  });

  return NextResponse.json({ item });
}

/** DELETE /api/menu/[id] — remove a menu item. Roles: hotel_admin only. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const existing = await db.menuItem.findFirst({ where: { id, propertyId } });
  if (!existing) {
    return NextResponse.json({ error: "Menu item not found" }, { status: 404 });
  }

  const used = await db.posOrderItem.findFirst({ where: { menuItemId: id }, select: { id: true } });
  if (used) {
    return NextResponse.json(
      { error: "This item is referenced by existing orders — mark it unavailable instead" },
      { status: 400 }
    );
  }

  await db.menuItem.delete({ where: { id } });
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "MENU_ITEM_DELETE",
    entity: "MenuItem",
    entityId: id,
    details: `${existing.name} (${existing.category}) removed from menu`,
  });

  return NextResponse.json({ ok: true });
}
