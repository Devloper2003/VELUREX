import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";
import { round2 } from "@/app/api/invoice/_shared";

/**
 * POST /api/groups/[code]/route-to-master — group master-folio routing.
 * Body: { fromReservationId, itemIds?: string[] }
 *
 * Moves unlocked, non-discount charges from a member folio onto the
 * designated master (payer) folio. When `itemIds` is provided only those
 * charges are moved (selective routing); otherwise every routeable charge on
 * the folio moves. Original line items are deleted and recreated on the
 * master with a provenance description so the group invoice shows who
 * actually consumed what. Payments stay on the room folios (they were
 * collected from the guest), so each member's balance reflects what the
 * group master still needs to collect from that room.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const fromReservationId = typeof body?.fromReservationId === "string" ? body.fromReservationId : "";
  const rawItemIds = Array.isArray(body?.itemIds) ? body.itemIds : null;
  const itemIds = rawItemIds
    ? [...new Set(rawItemIds.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : null;
  if (!fromReservationId) {
    return NextResponse.json({ error: "fromReservationId is required" }, { status: 400 });
  }

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: {
      guest: { select: { fullName: true } },
      room: { select: { number: true } },
    },
  });
  const source = members.find((m) => m.id === fromReservationId);
  if (!source) {
    return NextResponse.json({ error: "Reservation is not a member of this group" }, { status: 400 });
  }
  const master = members.find((m) => m.groupMaster);
  if (!master) {
    return NextResponse.json(
      { error: "Designate a group master folio first" },
      { status: 400 }
    );
  }
  if (master.id === source.id) {
    return NextResponse.json({ error: "This folio is already the group master" }, { status: 400 });
  }

  const allItems = await db.folioItem.findMany({
    where: { reservationId: source.id, locked: false, category: { not: "discount" } },
    orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
  });
  const items = itemIds ? allItems.filter((i) => itemIds.includes(i.id)) : allItems;
  if (items.length === 0) {
    return NextResponse.json(
      itemIds
        ? { error: "None of the selected charges can be routed (locked, discount, or not on this folio)" }
        : { error: "No routeable charges on this folio" },
      { status: 400 }
    );
  }
  if (itemIds && items.length < itemIds.length) {
    const skipped = itemIds.length - items.length;
    return NextResponse.json(
      { error: `${skipped} of the selected charge${skipped === 1 ? " is" : "s are"} locked or no longer routeable` },
      { status: 409 }
    );
  }

  const sourceLabel = source.room?.number || source.confirmationNumber;
  const movedAmount = round2(items.reduce((s, i) => s + i.amount, 0));

  const routedIds = await db.$transaction(async (tx) => {
    await tx.folioItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    const created = await Promise.all(
      items.map((i) =>
        tx.folioItem.create({
          data: {
            propertyId,
            reservationId: master.id,
            guestId: master.guestId,
            category: i.category,
            description: `${i.description} — routed from Room ${sourceLabel} (${source.guest.fullName})`,
            qty: i.qty,
            rate: i.rate,
            amount: i.amount,
            businessDate: i.businessDate,
            postedBy: auth.session.name,
          },
        })
      )
    );
    return created.map((c) => c.id);
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GROUP_ROUTE_MASTER",
    entity: "reservation",
    entityId: master.id,
    details: `Group ${groupCode}: routed ${items.length} charge(s) totalling ₹${movedAmount.toFixed(2)} from ${sourceLabel} (${source.guest.fullName}) to master folio ${master.room?.number ?? master.confirmationNumber} (${master.guest.fullName})`,
  });

  emitRealtime("global", "folio:update", { reservationId: master.id, kind: "group-route", amount: movedAmount });
  emitRealtime("global", "folio:update", { reservationId: source.id, kind: "group-route", amount: movedAmount });

  return NextResponse.json({
    routedCount: items.length,
    routedAmount: movedAmount,
    masterReservationId: master.id,
    routedItemIds: routedIds,
  });
}
