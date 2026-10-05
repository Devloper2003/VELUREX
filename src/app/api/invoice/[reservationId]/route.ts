import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { GST_BY_CATEGORY, HSN_BY_CATEGORY, buildTaxBreakup, round2 } from "@/app/api/invoice/_shared";

/**
 * GET /api/invoice/[reservationId] — GST tax invoice payload.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ reservationId: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { reservationId } = await params;

  const reservation = await db.reservation.findFirst({
    where: { id: reservationId, propertyId },
    include: {
      property: {
        select: { name: true, address: true, city: true, state: true, gstin: true, phone: true, email: true },
      },
      guest: {
        select: { fullName: true, phone: true, email: true, address: true, city: true, idType: true, idNumber: true },
      },
      room: { select: { number: true, roomType: { select: { name: true } } } },
    },
  });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });

  const [items, payments] = await Promise.all([
    db.folioItem.findMany({
      where: { reservationId },
      orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
    }),
    db.payment.findMany({ where: { reservationId }, orderBy: { createdAt: "desc" } }),
  ]);

  // Promo discount: a discount given at the time of supply reduces the taxable
  // value (CGST §15) — it is presented in the totals block, NOT as a 0% line,
  // and the GST breakup is computed on the net room taxable value.
  const discountItem = items.find((i) => i.category === "discount" && i.amount < 0) ?? null;
  const promoDiscount = discountItem
    ? {
        code: reservation.promoCode || "PROMO",
        amount: round2(Math.abs(discountItem.amount)),
        description: discountItem.description,
      }
    : null;

  const lineItems = items
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

  const subtotal = round2(lineItems.reduce((s, li) => s + li.taxable, 0));
  const discountTotal = promoDiscount?.amount ?? 0;
  // GST breakup with the discount netted per CGST §15 (shared helper)
  const taxBreakup = buildTaxBreakup(
    items.filter((i) => i.category !== "discount").map((i) => ({ category: i.category, amount: i.amount })),
    discountTotal
  );

  const totalTax = round2(taxBreakup.reduce((s, t) => s + t.tax, 0));
  const taxableTotal = round2(subtotal - discountTotal);
  const grandTotal = round2(taxableTotal + totalTax);
  const paid = round2(reservation.paidAmount);

  return NextResponse.json({
    invoiceNo: `INV-${reservation.confirmationNumber}`,
    date: new Date().toISOString(),
    hotel: reservation.property,
    billTo: reservation.guest,
    reservation: {
      id: reservation.id,
      confirmationNumber: reservation.confirmationNumber,
      status: reservation.status,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      nights: reservation.nights,
      nightlyRate: reservation.nightlyRate,
      groupCode: reservation.groupCode,
      room: reservation.room
        ? { number: reservation.room.number, roomType: { name: reservation.room.roomType.name } }
        : null,
    },
    lineItems,
    promoDiscount,
    discountTotal,
    taxBreakup,
    subtotal,
    taxableTotal,
    totalTax,
    grandTotal,
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      status: p.status,
      createdAt: p.createdAt,
    })),
    paid,
    balance: round2(grandTotal - paid),
  });
}
