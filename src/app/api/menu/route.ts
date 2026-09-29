import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const CATEGORIES = ["starter", "main", "dessert", "beverage", "bar"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** GET /api/menu?category= — menu items ordered by sortOrder. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const category = req.nextUrl.searchParams.get("category");
  const items = await db.menuItem.findMany({
    where: {
      propertyId,
      ...(category && CATEGORIES.includes(category) ? { category } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ items });
}

/** POST /api/menu — create a menu item. Roles: hotel_admin, restaurant_staff. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = str(body?.name);
  const category = str(body?.category);
  const price = Number(body?.price);
  if (!name || !CATEGORIES.includes(category) || !Number.isFinite(price) || price <= 0) {
    return NextResponse.json(
      { error: "name, a valid category (starter/main/dessert/beverage/bar) and a positive price are required" },
      { status: 400 }
    );
  }

  const last = await db.menuItem.findFirst({
    where: { propertyId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const item = await db.menuItem.create({
    data: {
      propertyId,
      name,
      category,
      price: Math.round(price * 100) / 100,
      isVeg: body?.isVeg !== false,
      available: body?.available !== false,
      description: str(body?.description),
      taxRate:
        Number.isFinite(Number(body?.taxRate)) && Number(body?.taxRate) >= 0
          ? Number(body?.taxRate)
          : category === "bar"
            ? 12
            : 5,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "MENU_ITEM_CREATE",
    entity: "MenuItem",
    entityId: item.id,
    details: `${name} (${category}) @ ₹${item.price}`,
  });

  return NextResponse.json({ item }, { status: 201 });
}
