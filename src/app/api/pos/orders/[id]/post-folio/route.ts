import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";

const FULL_INCLUDE = {
  items: { include: { menuItem: true } },
  reservation: { include: { guest: true, room: true } },
};

/**
 * POST /api/pos/orders/[id]/post-folio — room-charge posting to an in-house guest's folio.
 * body: { reservationId? } (falls back to order.reservationId)
 * Sets BOTH directions of the link: FolioItem.posOrderId (plain string) and
 * PosOrder.folioItemId (real FK → FolioItem).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const order = await db.posOrder.findFirst({
    where: { id, propertyId },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.paymentStatus !== "unpaid") {
    return NextResponse.json(
      { error: `Order is already ${order.paymentStatus.replace("_", " ")}` },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reservationId =
    typeof body?.reservationId === "string" && body.reservationId
      ? body.reservationId
      : order.reservationId;
  if (!reservationId) {
    return NextResponse.json(
      { error: "This order is not linked to a room reservation" },
      { status: 400 }
    );
  }

  const reservation = await db.reservation.findFirst({
    where: { id: reservationId, propertyId },
    include: { guest: true, room: true },
  });
  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  }
  if (reservation.status !== "checked_in") {
    return NextResponse.json(
      { error: `Guest is not checked in (status: ${reservation.status})` },
      { status: 400 }
    );
  }

  const property = await db.property.findUnique({ where: { id: propertyId } });

  // "bar" only when the order is entirely bar items; otherwise "fnb".
  const hasBar = order.items.some((i) => i.menuItem?.category === "bar");
  const hasFnb = order.items.some((i) => i.menuItem && i.menuItem.category !== "bar");
  const category = hasBar && !hasFnb ? "bar" : "fnb";

  // Item summary: first 2 item names + total qty.
  const totalQty = order.items.reduce((s, i) => s + i.qty, 0);
  const names = order.items.slice(0, 2).map((i) => `${i.qty}× ${i.name}`).join(", ");
  const summary = `${names}${order.items.length > 2 ? ` +${order.items.length - 2} more` : ""} — ${totalQty} item${totalQty === 1 ? "" : "s"}`;

  const folioItem = await db.folioItem.create({
    data: {
      propertyId,
      reservationId: reservation.id,
      guestId: reservation.guestId,
      category,
      description: `POS ${order.orderNumber} — ${summary}`,
      qty: 1,
      rate: order.totalAmount,
      amount: order.totalAmount,
      businessDate: property?.businessDate ?? new Date(),
      posOrderId: order.id, // plain string back-reference
      postedBy: auth.session.name,
    },
  });

  const updated = await db.posOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: "posted_to_folio",
      folioItemId: folioItem.id, // real FK → FolioItem
      status: "completed",
      reservationId: reservation.id,
    },
    include: FULL_INCLUDE,
  });

  const roomNumber = reservation.room?.number ?? order.roomNumber ?? "—";
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "POS_POST_FOLIO",
    entity: "PosOrder",
    entityId: order.id,
    details: `${order.orderNumber} · ₹${order.totalAmount} posted to Room ${roomNumber} folio (${reservation.guest.fullName})`,
  });

  // Live-push: kitchen clears the ticket, billing refreshes the folio.
  emitRealtime("kitchen", "kot:update", { kind: "settled", orderId: order.id, orderNumber: order.orderNumber });
  emitRealtime("global", "folio:update", { reservationId: reservation.id, kind: "pos_posted", orderId: order.id, amount: order.totalAmount });

  return NextResponse.json({ order: updated, folioItem });
}
