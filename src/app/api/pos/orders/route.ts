import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, type Role } from "@/lib/auth";
import { logActivity, nextOrderNumber, startOfDay } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";
import { getTenantEntitlements, requireFeature, assertWritable } from "@/lib/entitlements";
import { broadcastKot } from "@/lib/kot-broadcast";
import { computePosTotals } from "@/lib/pos-gst";
import { handleRoute } from "@/lib/route-error";

const ORDER_TYPES = ["dine_in", "room_service", "takeaway"];
const POS_ROLES: Role[] = ["hotel_admin", "restaurant_staff", "front_desk"];

const round2 = (n: number) => Math.round(n * 100) / 100;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Shared include for a "full" order (PosOrderItem has no createdAt — natural insertion order). */
const FULL_INCLUDE = {
  items: { include: { menuItem: true } },
  reservation: { include: { guest: true, room: true } },
};

/**
 * GET /api/pos/orders?status=&active=1&today=1
 * active=1 → status in [pending, preparing, served]; today=1 → createdAt ≥ start of today.
 */
export async function GET(req: NextRequest) {
  return handleRoute("pos.ordersList", () => ordersGet(req));
}

async function ordersGet(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, POS_ROLES);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const sp = req.nextUrl.searchParams;
  const where: {
    propertyId: string;
    status?: string | { in: string[] };
    createdAt?: { gte: Date };
  } = { propertyId };

  if (sp.get("active") === "1") {
    where.status = { in: ["pending", "preparing", "served"] };
  } else if (sp.get("status")) {
    where.status = String(sp.get("status"));
  }
  if (sp.get("today") === "1") {
    where.createdAt = { gte: startOfDay(new Date()) };
  }

  const orders = await db.posOrder.findMany({
    where,
    include: FULL_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ orders });
}

/**
 * POST /api/pos/orders — create an order (KOT). Roles: hotel_admin, restaurant_staff, front_desk.
 * body: { orderType, tableNumber?, roomNumber?, reservationId?, guestName?, items: [{ menuItemId, qty, notes? }] }
 */
export async function POST(req: NextRequest) {
  return handleRoute("pos.ordersCreate", () => ordersPost(req));
}

async function ordersPost(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, POS_ROLES);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: the restaurant POS module is a Pro+ feature.
  const ent = await getTenantEntitlements(propertyId);
  const locked = requireFeature(ent, "pos", "Restaurant POS");
  if (locked) return locked;
  const ro = assertWritable(ent);
  if (ro) return ro;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const orderType = ORDER_TYPES.includes(str(body.orderType)) ? str(body.orderType) : "dine_in";
  const rawItems = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: "At least one item is required" }, { status: 400 });
  }

  // Room service → resolve the in-house reservation (by id or room number).
  let reservation: {
    id: string;
    guestId: string;
    guest: { fullName: string };
    room: { number: string } | null;
  } | null = null;

  if (orderType === "room_service") {
    const reservationId = str(body.reservationId);
    const roomNumber = str(body.roomNumber);
    if (reservationId) {
      reservation = await db.reservation.findFirst({
        where: { id: reservationId, propertyId, status: "checked_in" },
        include: { guest: true, room: true },
      });
    } else if (roomNumber) {
      const room = await db.room.findFirst({ where: { propertyId, number: roomNumber } });
      if (room) {
        reservation = await db.reservation.findFirst({
          where: { propertyId, roomId: room.id, status: "checked_in" },
          include: { guest: true, room: true },
        });
      }
    } else {
      return NextResponse.json(
        { error: "Room service requires reservationId or roomNumber" },
        { status: 400 }
      );
    }
    if (!reservation) {
      return NextResponse.json(
        { error: "No checked-in reservation found for that room" },
        { status: 400 }
      );
    }
  }

  // Load and validate menu items, then run the shared POS GST engine —
  // discount applies BEFORE tax (CGST §15): GST is charged on the discounted
  // taxable value, split CGST 2.5% + SGST 2.5% on the flat 5% slab.
  const ids = rawItems.map((i) => str(i.menuItemId)).filter(Boolean);
  const menuItems = await db.menuItem.findMany({ where: { id: { in: ids }, propertyId } });
  const menuMap = new Map(menuItems.map((m) => [m.id, m]));

  const taxedLines: { price: number; qty: number; taxRate: number }[] = [];
  const orderItems: {
    menuItemId: string;
    name: string;
    qty: number;
    price: number;
    amount: number;
    notes: string;
    status: string;
  }[] = [];

  for (const raw of rawItems) {
    const menuItemId = str(raw.menuItemId);
    const menu = menuMap.get(menuItemId);
    if (!menu) {
      return NextResponse.json({ error: `Unknown menu item: ${menuItemId || "(missing id)"}` }, { status: 400 });
    }
    if (!menu.available) {
      return NextResponse.json({ error: `${menu.name} is sold out` }, { status: 400 });
    }
    const qty = Math.max(1, Math.floor(Number(raw.qty) || 0));
    const amount = round2(menu.price * qty);
    taxedLines.push({ price: menu.price, qty, taxRate: menu.taxRate });
    orderItems.push({
      menuItemId: menu.id,
      name: menu.name,
      qty,
      price: menu.price,
      amount,
      notes: str(raw.notes).slice(0, 200),
      status: "pending",
    });
  }

  const discountMode = ["percent", "flat"].includes(str(body.discountMode))
    ? str(body.discountMode)
    : "none";
  const discountValue = Math.max(0, Number(body.discountValue) || 0);
  const totals = computePosTotals(taxedLines, discountMode, discountValue);

  const order = await db.posOrder.create({
    data: {
      propertyId,
      orderNumber: nextOrderNumber(),
      orderType,
      tableNumber: orderType === "dine_in" ? str(body.tableNumber) : "",
      roomNumber: orderType === "room_service" ? reservation?.room?.number ?? str(body.roomNumber) : "",
      reservationId: reservation?.id ?? null,
      guestName: str(body.guestName) || reservation?.guest.fullName || "",
      status: "pending",
      subtotal: totals.subtotal,
      discountMode,
      discountValue,
      discountAmount: totals.discountAmount,
      taxAmount: totals.tax,
      totalAmount: totals.total,
      items: { create: orderItems },
    },
    include: FULL_INCLUDE,
  });

  const where = order.orderType === "dine_in" ? `Table ${order.tableNumber || "—"}` : order.orderType === "room_service" ? `Room ${order.roomNumber}` : "Takeaway";
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "POS_ORDER_CREATE",
    entity: "PosOrder",
    entityId: order.id,
    details: `${order.orderNumber} · ${where} · ${order.items.length} items · ₹${totals.total}${totals.discountAmount > 0 ? ` (−₹${totals.discountAmount} discount)` : ""}`,
  });

  // Live-push to kitchen displays + POS terminals (best-effort).
  emitRealtime("kitchen", "kot:update", {
    kind: "new",
    orderId: order.id,
    orderNumber: order.orderNumber,
    where,
    itemCount: order.items.length,
    totalAmount: totals.total,
  });
  emitRealtime("global", "kot:update", { kind: "new", orderId: order.id, orderNumber: order.orderNumber, where });

  // Owner + group WhatsApp broadcast of the fresh KOT (branded image, text
  // fallback) — best-effort, never blocks or fails the order.
  const kotBroadcast = await broadcastKot(propertyId, {
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableNumber: order.tableNumber,
    roomNumber: order.roomNumber,
    createdAt: order.createdAt,
    subtotal: order.subtotal,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    items: order.items.map((i) => ({ name: i.name, qty: i.qty, notes: i.notes })),
  });

  return NextResponse.json({ order, kotBroadcast }, { status: 201 });
}
