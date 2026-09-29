import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";

const CHARGE_CATEGORIES = ["room", "fnb", "laundry", "misc", "bar", "discount", "no_show"];
const round2 = (n: number) => Math.round(n * 100) / 100;

async function computeTotals(reservationId: string) {
  const agg = await db.folioItem.aggregate({
    where: { reservationId },
    _sum: { amount: true },
  });
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    select: { paidAmount: true },
  });
  const charges = round2(agg._sum.amount ?? 0);
  const paid = round2(reservation?.paidAmount ?? 0);
  return { charges, paid, balance: round2(charges - paid) };
}

/**
 * Task 2-b owns the full folio surface (supersedes the earlier minimal GET stub).
 *
 * GET /api/folio                 → open folios list (checked_in + checked_out)
 * GET /api/folio?reservationId=  → full folio detail (items, payments, totals)
 *                                 (also returns legacy keys folioItems/total/
 *                                  paidAmount/balance for earlier consumers)
 * Filters: ?search=&status=(in_house|departed|checked_in|checked_out)&group=&guestId=
 *
 * POST /api/folio — post a charge.
 * Body: { reservationId, category, description, qty, rate }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const sp = req.nextUrl.searchParams;
  const reservationId = sp.get("reservationId");
  const guestId = sp.get("guestId");

  // ── Full folio detail ────────────────────────────────────────────────────
  if (reservationId) {
    const reservation = await db.reservation.findFirst({
      where: { id: reservationId, propertyId },
      include: {
        guest: {
          select: { fullName: true, phone: true, email: true, address: true, city: true, idType: true, idNumber: true },
        },
        room: { select: { number: true, roomType: { select: { name: true } } } },
      },
    });
    if (!reservation) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    }
    const [items, payments] = await Promise.all([
      db.folioItem.findMany({
        where: { reservationId, ...(guestId ? { guestId } : {}) },
        orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
      }),
      db.payment.findMany({ where: { reservationId }, orderBy: { createdAt: "desc" } }),
    ]);
    // Folio-item sums are the authoritative charge total
    const charges = round2(items.reduce((s, i) => s + i.amount, 0));
    const paid = round2(reservation.paidAmount);
    const balance = round2(charges - paid);
    return NextResponse.json({
      reservation: {
        id: reservation.id,
        confirmationNumber: reservation.confirmationNumber,
        status: reservation.status,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        nights: reservation.nights,
        nightlyRate: reservation.nightlyRate,
        totalAmount: reservation.totalAmount,
        paidAmount: reservation.paidAmount,
        groupCode: reservation.groupCode,
        groupMaster: reservation.groupMaster,
        guest: reservation.guest,
        room: reservation.room
          ? { number: reservation.room.number, roomType: { name: reservation.room.roomType.name } }
          : null,
      },
      items,
      payments,
      totals: { charges, paid, balance },
      // Legacy shape kept for consumers of the earlier minimal endpoint
      folioItems: items,
      total: charges,
      paidAmount: paid,
      balance,
    });
  }

  // ── Open folios list ─────────────────────────────────────────────────────
  const search = (sp.get("search") || "").trim();
  const statusParam = (sp.get("status") || "").trim();
  const group = (sp.get("group") || "").trim();

  const statusFilter =
    statusParam === "in_house"
      ? ["checked_in"]
      : statusParam === "departed"
        ? ["checked_out"]
        : ["checked_in", "checked_out"].includes(statusParam)
          ? [statusParam]
          : ["checked_in", "checked_out"];

  const reservations = await db.reservation.findMany({
    where: {
      propertyId,
      status: { in: statusFilter },
      ...(group ? { groupCode: group } : {}),
      ...(guestId ? { guestId } : {}),
      ...(search
        ? {
            OR: [
              { guest: { is: { fullName: { contains: search, mode: "insensitive" } } } },
              { confirmationNumber: { contains: search, mode: "insensitive" } },
              { room: { is: { number: { contains: search, mode: "insensitive" } } } },
            ],
          }
        : {}),
    },
    include: {
      guest: { select: { fullName: true } },
      room: { select: { number: true } },
    },
    orderBy: [{ status: "asc" }, { checkIn: "desc" }],
  });

  const ids = reservations.map((r) => r.id);
  const sums = ids.length
    ? await db.folioItem.groupBy({
        by: ["reservationId"],
        where: { propertyId, reservationId: { in: ids } },
        _sum: { amount: true },
      })
    : [];
  const chargesByRes = new Map(sums.map((s) => [s.reservationId, round2(s._sum.amount ?? 0)]));

  const folios = reservations.map((r) => {
    const charges = chargesByRes.get(r.id) ?? 0;
    const paid = round2(r.paidAmount);
    return {
      reservationId: r.id,
      confirmationNumber: r.confirmationNumber,
      guestName: r.guest.fullName,
      roomNumber: r.room?.number ?? "—",
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      status: r.status,
      totalAmount: r.totalAmount,
      paidAmount: paid,
      groupCode: r.groupCode,
      groupMaster: r.groupMaster,
      balance: round2(charges - paid),
    };
  });

  return NextResponse.json({ folios });
}

/**
 * POST /api/folio — post a charge to a folio.
 * Body: { reservationId, category, description, qty, rate }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const reservationId = typeof body.reservationId === "string" ? body.reservationId : "";
  const category = typeof body.category === "string" ? body.category : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const qty = Number(body.qty);
  const rate = Number(body.rate);

  if (!reservationId) return NextResponse.json({ error: "reservationId is required" }, { status: 400 });
  if (!CHARGE_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `Invalid category — must be one of: ${CHARGE_CATEGORIES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!description) return NextResponse.json({ error: "Description is required" }, { status: 400 });
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: "Qty must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(rate) || rate === 0) {
    return NextResponse.json(
      { error: "Rate must be a non-zero number (negative allowed for discount)" },
      { status: 400 }
    );
  }

  const [reservation, property] = await Promise.all([
    db.reservation.findFirst({ where: { id: reservationId, propertyId } }),
    db.property.findUnique({ where: { id: propertyId }, select: { businessDate: true } }),
  ]);
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  if (["cancelled", "no_show"].includes(reservation.status)) {
    return NextResponse.json(
      { error: "Cannot post charges to a cancelled or no-show reservation" },
      { status: 400 }
    );
  }

  // Offline-sync idempotency: a replayed queued charge returns the original item.
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.trim() : "";
  if (clientRef) {
    const existing = await db.folioItem.findFirst({
      where: { propertyId, reservationId, clientRef },
      select: { id: true },
    });
    if (existing) {
      const item = await db.folioItem.findUnique({ where: { id: existing.id } });
      return NextResponse.json({ item, totals: await computeTotals(reservationId), idempotentReplay: true });
    }
  }

  const amount = round2(qty * rate);
  const item = await db.folioItem.create({
    data: {
      propertyId,
      reservationId,
      guestId: reservation.guestId,
      category,
      description,
      qty,
      rate,
      amount,
      businessDate: property?.businessDate ?? new Date(),
      postedBy: auth.session.name,
      clientRef,
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "FOLIO_CHARGE",
    entity: "folio_item",
    entityId: item.id,
    details: `${description} · ${category} · ₹${amount.toFixed(2)} → ${reservation.confirmationNumber}`,
  });

  // Live-push so Billing/Folio views refresh instantly (best-effort).
  emitRealtime("global", "folio:update", { reservationId, kind: "charge", itemId: item.id, amount });

  return NextResponse.json({ item, totals: await computeTotals(reservationId) }, { status: 201 });
}
