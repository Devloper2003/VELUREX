import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/pos/kot — kitchen queue: orders in [pending, preparing], oldest first.
 * Each item: { id, name, qty, notes, status }.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const orders = await db.posOrder.findMany({
    where: { propertyId, status: { in: ["pending", "preparing"] } },
    include: { items: { orderBy: { id: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  const now = Date.now();
  return NextResponse.json({
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType,
      tableNumber: o.tableNumber,
      roomNumber: o.roomNumber,
      guestName: o.guestName,
      createdAt: o.createdAt,
      elapsedMinutes: Math.max(0, Math.floor((now - o.createdAt.getTime()) / 60000)),
      items: o.items.map((i) => ({
        id: i.id,
        name: i.name,
        qty: i.qty,
        notes: i.notes,
        status: i.status,
      })),
    })),
  });
}
