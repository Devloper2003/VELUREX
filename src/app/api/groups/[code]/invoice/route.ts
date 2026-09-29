import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { GST_BY_CATEGORY, HSN_BY_CATEGORY, buildTaxBreakup, round2 } from "@/app/api/invoice/_shared";

/**
 * GET /api/groups/[code]/invoice — consolidated GST tax invoice for a group.
 *
 * One tax invoice covering every member folio: per-room charge sections
 * (room, guest, conf #, lines with HSN + GST), a group-level GST breakup,
 * grand totals, and all payments collected across the group. Charges routed
 * to the master folio appear on the master's section (with provenance), so
 * nothing is double-counted.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: {
      property: { select: { name: true, address: true, city: true, gstin: true, phone: true } },
      guest: { select: { fullName: true, phone: true, email: true, address: true, city: true } },
      room: { select: { number: true, roomType: { select: { name: true } } } },
    },
    orderBy: [{ room: { number: "asc" } }, { createdAt: "asc" }],
  });
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  const ids = members.map((m) => m.id);
  const [allItems, allPayments] = await Promise.all([
    db.folioItem.findMany({
      where: { reservationId: { in: ids } },
      orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
    }),
    db.payment.findMany({ where: { reservationId: { in: ids } }, orderBy: { createdAt: "desc" } }),
  ]);

  const first = members[0];
  // Avoid the "INV-GRP-GRP-…" stutter when the group code already starts with GRP-
  const invoiceNo = /^GRP-/i.test(groupCode) ? `INV-${groupCode}` : `INV-GRP-${groupCode}`;
  const master = members.find((m) => m.groupMaster) ?? null;

  const rooms = members.map((m) => {
    const items = allItems.filter((i) => i.reservationId === m.id);
    const discountItem = items.find((i) => i.category === "discount" && i.amount < 0) ?? null;
    const promoDiscount = discountItem
      ? { code: m.promoCode || "PROMO", amount: round2(Math.abs(discountItem.amount)), description: discountItem.description }
      : null;
    const lines = items
      .filter((i) => i.category !== "discount")
      .map((i) => {
        const gstRate = GST_BY_CATEGORY[i.category] ?? 0;
        const taxable = round2(i.amount);
        return {
          id: i.id,
          date: i.businessDate,
          category: i.category,
          description: i.description,
          hsn: HSN_BY_CATEGORY[i.category] ?? "—",
          qty: i.qty,
          rate: i.rate,
          taxable,
          gstRate,
          gstAmount: round2((taxable * gstRate) / 100),
        };
      });
    const charges = round2(items.reduce((s, i) => s + i.amount, 0));
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
      isMaster: m.groupMaster,
      lineItems: lines,
      promoDiscount,
      charges,
      paid,
      balance: round2(charges - paid),
      subtotal: round2(lines.reduce((s, li) => s + li.taxable, 0)),
    };
  });

  // Group-level tax breakup across every room's charge lines, netting all
  // promo discounts (CGST §15).
  const chargeLines = allItems.filter((i) => i.category !== "discount").map((i) => ({ category: i.category, amount: i.amount }));
  const discountTotal = round2(
    rooms.reduce((s, r) => s + (r.promoDiscount?.amount ?? 0), 0)
  );
  const taxBreakup = buildTaxBreakup(chargeLines, discountTotal);

  const subtotal = round2(rooms.reduce((s, r) => s + r.subtotal, 0));
  const totalTax = round2(taxBreakup.reduce((s, t) => s + t.tax, 0));
  const taxableTotal = round2(subtotal - discountTotal);
  const grandTotal = round2(taxableTotal + totalTax);
  const paid = round2(rooms.reduce((s, r) => s + r.paid, 0));

  return NextResponse.json({
    invoiceNo,
    date: new Date().toISOString(),
    hotel: first.property,
    group: {
      code: groupCode,
      masterGuestName: master?.guest.fullName ?? null,
      masterRoomNumber: master?.room?.number ?? null,
      roomCount: rooms.length,
      notes: [
        master
          ? `Master payer folio: ${master.guest.fullName} (Room ${master.room?.number ?? master.confirmationNumber}). Charges routed to the master appear under that room's section with their room of origin.`
          : "No master payer folio designated for this group — charges are billed per room.",
        ...rooms.flatMap((r) => (r.promoDiscount ? [`Room ${r.roomNumber}: promotional discount ${r.promoDiscount.code} (−₹${r.promoDiscount.amount.toFixed(2)}) applied before GST.`] : [])),
      ],
    },
    billTo: master?.guest ?? first.guest,
    rooms,
    taxBreakup,
    subtotal,
    discountTotal,
    taxableTotal,
    totalTax,
    grandTotal,
    paid,
    balance: round2(grandTotal - paid),
    payments: allPayments.map((p) => ({
      id: p.id,
      reservationId: p.reservationId,
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      status: p.status,
      createdAt: p.createdAt,
    })),
  });
}
