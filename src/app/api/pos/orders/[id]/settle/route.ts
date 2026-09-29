import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const METHODS = ["cash", "upi", "card"];

const FULL_INCLUDE = {
  items: { include: { menuItem: true } },
  reservation: { include: { guest: true, room: true } },
};

/**
 * POST /api/pos/orders/[id]/settle — direct payment settle.
 * body: { method: "cash" | "upi" | "card" }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const order = await db.posOrder.findFirst({ where: { id, propertyId } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.paymentStatus !== "unpaid") {
    return NextResponse.json(
      { error: `Order is already ${order.paymentStatus.replace("_", " ")}` },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const method = typeof body?.method === "string" ? body.method : "";
  if (!METHODS.includes(method)) {
    return NextResponse.json({ error: "method must be cash, upi or card" }, { status: 400 });
  }

  const payment = await db.payment.create({
    data: {
      propertyId,
      reservationId: null,
      posOrderId: order.id,
      amount: order.totalAmount,
      method,
      status: "success",
      receivedBy: auth.session.name,
    },
  });

  const updated = await db.posOrder.update({
    where: { id: order.id },
    data: { paymentStatus: "paid", paymentMethod: method, status: "completed" },
    include: FULL_INCLUDE,
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "POS_SETTLE",
    entity: "PosOrder",
    entityId: order.id,
    details: `${order.orderNumber} settled ${method.toUpperCase()} ₹${order.totalAmount}`,
  });

  return NextResponse.json({ order: updated, payment });
}
