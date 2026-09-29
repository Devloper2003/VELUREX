import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { emitRealtime } from "@/lib/realtime-server";

/** Allowed item-level KOT progression. */
const ITEM_FLOW: Record<string, string> = {
  pending: "preparing",
  preparing: "ready",
  ready: "served",
};

/** PATCH /api/pos/items/[id] — item-level KOT progression: pending → preparing → ready → served. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const item = await db.posOrderItem.findFirst({ where: { id }, include: { order: true } });
  if (!item || item.order.propertyId !== propertyId) {
    return NextResponse.json({ error: "Order item not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const next = typeof body?.status === "string" ? body.status : "";
  if (ITEM_FLOW[item.status] !== next) {
    return NextResponse.json(
      { error: `Cannot move item from ${item.status} to ${next || "(none)"}` },
      { status: 400 }
    );
  }

  const updated = await db.posOrderItem.update({ where: { id }, data: { status: next } });

  // Live-push so every kitchen screen mirrors the chip flip (best-effort).
  emitRealtime("kitchen", "kot:update", {
    kind: "item_status",
    orderId: item.order.id,
    orderNumber: item.order.orderNumber,
    itemId: item.id,
    itemName: item.name,
    from: item.status,
    to: next,
  });
  emitRealtime("global", "kot:update", {
    kind: "item_status",
    orderId: item.order.id,
    orderNumber: item.order.orderNumber,
    itemId: item.id,
    from: item.status,
    to: next,
  });

  return NextResponse.json({ item: updated });
}
