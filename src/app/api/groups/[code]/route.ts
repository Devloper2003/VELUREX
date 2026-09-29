import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { round2 } from "@/app/api/invoice/_shared";

/**
 * Group-billing surface for a reservation group (shared groupCode).
 *
 * GET  /api/groups/[code] → member folios with charges/paid/balance + grand totals
 * POST /api/groups/[code] → { action: "designate-master", reservationId }
 */

async function loadGroup(propertyId: string, code: string) {
  const members = await db.reservation.findMany({
    where: { propertyId, groupCode: code },
    include: {
      guest: { select: { fullName: true } },
      room: { select: { number: true, roomType: { select: { name: true } } } },
    },
    orderBy: [{ room: { number: "asc" } }, { createdAt: "asc" }],
  });
  return members;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const members = await loadGroup(propertyId, groupCode);
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  const ids = members.map((m) => m.id);
  const [sums, lockedSums, routeableItems, payments] = await Promise.all([
    db.folioItem.groupBy({
      by: ["reservationId"],
      where: { propertyId, reservationId: { in: ids } },
      _sum: { amount: true },
    }),
    // Unlocked, non-discount charges are the ones that can be routed away
    db.folioItem.groupBy({
      by: ["reservationId"],
      where: { propertyId, reservationId: { in: ids }, locked: false, category: { not: "discount" } },
      _sum: { amount: true },
    }),
    // Item-level detail so the UI can offer selective routing
    db.folioItem.findMany({
      where: { propertyId, reservationId: { in: ids }, locked: false, category: { not: "discount" } },
      orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, reservationId: true, category: true, description: true, amount: true, businessDate: true },
    }),
    // Payments across member folios (newest first) — the drawer lists deposits
    // and offers a receipt download per payment.
    db.payment.findMany({
      where: { propertyId, reservationId: { in: ids } },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        reservation: {
          select: { confirmationNumber: true, guest: { select: { fullName: true } }, room: { select: { number: true } } },
        },
      },
    }),
  ]);
  const chargesBy = new Map(sums.map((s) => [s.reservationId, round2(s._sum.amount ?? 0)]));
  const routeableBy = new Map(lockedSums.map((s) => [s.reservationId, round2(s._sum.amount ?? 0)]));
  const itemsBy = new Map<string, { id: string; category: string; description: string; amount: number; businessDate: string }[]>();
  for (const it of routeableItems) {
    const list = itemsBy.get(it.reservationId) ?? [];
    list.push({ id: it.id, category: it.category, description: it.description, amount: round2(it.amount), businessDate: it.businessDate.toISOString() });
    itemsBy.set(it.reservationId, list);
  }

  const paymentRows = payments.map((p) => ({
    id: p.id,
    amount: round2(p.amount),
    method: p.method,
    reference: p.reference,
    receivedBy: p.receivedBy,
    createdAt: p.createdAt.toISOString(),
    confirmationNumber: p.reservation?.confirmationNumber ?? null,
    guestName: p.reservation?.guest.fullName ?? null,
    roomNumber: p.reservation?.room?.number ?? null,
  }));

  const rows = members.map((m) => {
    const charges = chargesBy.get(m.id) ?? 0;
    const paid = round2(m.paidAmount);
    return {
      reservationId: m.id,
      confirmationNumber: m.confirmationNumber,
      guestName: m.guest.fullName,
      roomNumber: m.room?.number ?? "—",
      roomTypeName: m.room?.roomType.name ?? "—",
      status: m.status,
      checkIn: m.checkIn,
      checkOut: m.checkOut,
      nights: m.nights,
      nightlyRate: m.nightlyRate,
      totalAmount: m.totalAmount,
      charges,
      paid,
      balance: round2(charges - paid),
      isMaster: m.groupMaster,
      routeableAmount: routeableBy.get(m.id) ?? 0,
      routeableItems: itemsBy.get(m.id) ?? [],
    };
  });

  const grand = {
    charges: round2(rows.reduce((s, r) => s + r.charges, 0)),
    paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
    rooms: rows.length,
    balance: round2(rows.reduce((s, r) => s + r.balance, 0)),
  };
  const masterRow = rows.find((r) => r.isMaster) ?? null;

  return NextResponse.json({
    group: {
      code: groupCode,
      masterReservationId: masterRow?.reservationId ?? null,
      masterGuestName: masterRow?.guestName ?? null,
      masterRoomNumber: masterRow?.roomNumber ?? null,
      members: rows,
      grand,
      payments: paymentRows,
    },
  });
}

/**
 * POST /api/groups/[code] — group administration actions.
 * Body: { action: "designate-master", reservationId }
 * Exactly one member of the group carries the master (payer) flag; routed
 * charges and the consolidated invoice are anchored on that folio.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  const reservationId = typeof body?.reservationId === "string" ? body.reservationId : "";

  if (action !== "designate-master") {
    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  }
  if (!reservationId) return NextResponse.json({ error: "reservationId is required" }, { status: 400 });

  const members = await loadGroup(propertyId, groupCode);
  const target = members.find((m) => m.id === reservationId);
  if (!target) {
    return NextResponse.json({ error: "Reservation is not a member of this group" }, { status: 400 });
  }

  await db.$transaction([
    ...members
      .filter((m) => m.groupMaster && m.id !== reservationId)
      .map((m) => db.reservation.update({ where: { id: m.id }, data: { groupMaster: false } })),
    db.reservation.update({ where: { id: reservationId }, data: { groupMaster: true } }),
  ]);

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GROUP_MASTER_SET",
    entity: "reservation",
    entityId: reservationId,
    details: `Group ${groupCode}: master payer folio set to ${target.guest.fullName} (${target.room?.number ?? target.confirmationNumber})`,
  });

  return NextResponse.json({ ok: true, masterReservationId: reservationId });
}
