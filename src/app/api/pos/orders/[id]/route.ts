import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";

const FULL_INCLUDE = {
  items: { include: { menuItem: true } },
  reservation: { include: { guest: true, room: true } },
};

/** Allowed order status transitions. */
const FLOW: Record<string, string[]> = {
  pending: ["preparing", "cancelled"],
  preparing: ["served", "cancelled"],
  served: ["completed"],
  completed: [],
  cancelled: [],
};

/** PATCH /api/pos/orders/[id] — advance order status through the KOT flow. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const order = await db.posOrder.findFirst({ where: { id, propertyId } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const next = typeof body?.status === "string" ? body.status : "";
  if (!FLOW[order.status] || !FLOW[order.status].includes(next)) {
    return NextResponse.json(
      { error: `Cannot move order from ${order.status} to ${next || "(none)"}` },
      { status: 400 }
    );
  }
  if (next === "cancelled" && order.paymentStatus !== "unpaid") {
    return NextResponse.json({ error: "Cannot cancel a settled order" }, { status: 400 });
  }

  const updated = await db.posOrder.update({
    where: { id },
    data: {
      status: next,
      ...(next === "served" ? { servedBy: auth.session.name } : {}),
    },
    include: FULL_INCLUDE,
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "POS_ORDER_STATUS",
    entity: "PosOrder",
    entityId: order.id,
    details: `${order.orderNumber}: ${order.status} → ${next}`,
  });

  // Live-push the KOT queue change to kitchen + POS terminals.
  emitRealtime("kitchen", "kot:update", {
    kind: "status",
    orderId: order.id,
    orderNumber: order.orderNumber,
    from: order.status,
    to: next,
  });
  emitRealtime("global", "kot:update", { kind: "status", orderId: order.id, orderNumber: order.orderNumber, from: order.status, to: next });

  return NextResponse.json({ order: updated });
}
