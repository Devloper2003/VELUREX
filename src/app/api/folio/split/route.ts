import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * POST /api/folio/split — split billing.
 * Body: { itemId, targetReservationId, qtyToMove? }
 * Moves qtyToMove (default: full qty) of a charge to the target reservation's folio.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const targetReservationId =
    typeof body.targetReservationId === "string" ? body.targetReservationId : "";

  if (!itemId) return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  if (!targetReservationId) {
    return NextResponse.json({ error: "targetReservationId is required" }, { status: 400 });
  }

  const item = await db.folioItem.findFirst({ where: { id: itemId, propertyId } });
  if (!item) return NextResponse.json({ error: "Folio item not found" }, { status: 404 });
  if (item.locked) {
    return NextResponse.json({ error: "Item is locked by night audit and cannot be split" }, { status: 400 });
  }
  if (targetReservationId === item.reservationId) {
    return NextResponse.json({ error: "Target folio must be different from the source folio" }, { status: 400 });
  }

  const [source, target] = await Promise.all([
    db.reservation.findFirst({
      where: { id: item.reservationId, propertyId },
      include: { room: { select: { number: true } } },
    }),
    db.reservation.findFirst({
      where: { id: targetReservationId, propertyId },
      include: { guest: { select: { fullName: true } }, room: { select: { number: true } } },
    }),
  ]);
  if (!source) return NextResponse.json({ error: "Source reservation not found" }, { status: 404 });
  if (!target) return NextResponse.json({ error: "Target reservation not found" }, { status: 400 });

  const qtyToMove = body.qtyToMove === undefined || body.qtyToMove === null ? item.qty : Number(body.qtyToMove);
  if (!Number.isFinite(qtyToMove) || qtyToMove <= 0) {
    return NextResponse.json({ error: "qtyToMove must be a positive number" }, { status: 400 });
  }
  if (qtyToMove > item.qty) {
    return NextResponse.json({ error: `Cannot move more than the item qty (${item.qty})` }, { status: 400 });
  }

  const sourceLabel = source.room?.number || source.confirmationNumber;
  const movedAmount = round2(qtyToMove * item.rate);

  const targetItem = await db.$transaction(async (tx) => {
    // Reduce or delete the source item
    if (qtyToMove >= item.qty) {
      await tx.folioItem.delete({ where: { id: item.id } });
    } else {
      await tx.folioItem.update({
        where: { id: item.id },
        data: { qty: round2(item.qty - qtyToMove), amount: round2((item.qty - qtyToMove) * item.rate) },
      });
    }
    // Create the matching charge on the target folio
    return tx.folioItem.create({
      data: {
        propertyId,
        reservationId: targetReservationId,
        guestId: target.guestId,
        category: item.category,
        description: `${item.description} (split from ${sourceLabel})`,
        qty: qtyToMove,
        rate: item.rate,
        amount: movedAmount,
        businessDate: item.businessDate,
        postedBy: auth.session.name,
      },
    });
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "FOLIO_SPLIT",
    entity: "folio_item",
    entityId: targetItem.id,
    details: `Split "${item.description}" — qty ${qtyToMove} (₹${movedAmount.toFixed(2)}) from ${sourceLabel} to ${target.room?.number || target.confirmationNumber} (${target.guest.fullName})`,
  });

  return NextResponse.json({ targetItem, sourceItemId: item.id, removedSource: qtyToMove >= item.qty });
}
