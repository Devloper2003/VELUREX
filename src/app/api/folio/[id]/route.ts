import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const round2 = (n: number) => Math.round(n * 100) / 100;

async function computeTotals(reservationId: string) {
  const agg = await db.folioItem.aggregate({ where: { reservationId }, _sum: { amount: true } });
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    select: { paidAmount: true },
  });
  const charges = round2(agg._sum.amount ?? 0);
  const paid = round2(reservation?.paidAmount ?? 0);
  return { charges, paid, balance: round2(charges - paid) };
}

/**
 * PATCH /api/folio/[id] — edit an unlocked folio item.
 * Body: { qty?, rate?, description? } — amount recomputed as qty × rate.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const item = await db.folioItem.findFirst({ where: { id, propertyId } });
  if (!item) return NextResponse.json({ error: "Folio item not found" }, { status: 404 });
  if (item.locked) {
    return NextResponse.json({ error: "Item is locked by night audit and cannot be edited" }, { status: 400 });
  }

  const qty = body.qty !== undefined ? Number(body.qty) : item.qty;
  const rate = body.rate !== undefined ? Number(body.rate) : item.rate;
  const description =
    body.description !== undefined ? String(body.description).trim() : item.description;

  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: "Qty must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(rate) || rate === 0) {
    return NextResponse.json({ error: "Rate must be a non-zero number" }, { status: 400 });
  }
  if (!description) return NextResponse.json({ error: "Description is required" }, { status: 400 });

  const updated = await db.folioItem.update({
    where: { id: item.id },
    data: { qty, rate, description, amount: round2(qty * rate) },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "FOLIO_UPDATE",
    entity: "folio_item",
    entityId: updated.id,
    details: `Edited "${description}" — qty ${qty} × ₹${rate} = ₹${updated.amount.toFixed(2)}`,
  });

  return NextResponse.json({ item: updated, totals: await computeTotals(item.reservationId) });
}

/**
 * DELETE /api/folio/[id] — void an unlocked folio item.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const item = await db.folioItem.findFirst({ where: { id, propertyId } });
  if (!item) return NextResponse.json({ error: "Folio item not found" }, { status: 404 });
  if (item.locked) {
    return NextResponse.json({ error: "Item is locked by night audit and cannot be voided" }, { status: 400 });
  }

  await db.folioItem.delete({ where: { id: item.id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "FOLIO_VOID",
    entity: "folio_item",
    entityId: item.id,
    details: `Voided "${item.description}" (${item.category}) — ₹${item.amount.toFixed(2)}`,
  });

  return NextResponse.json({ ok: true, totals: await computeTotals(item.reservationId) });
}
