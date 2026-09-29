import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { round2 } from "@/app/api/invoice/_shared";

/**
 * GET /api/receipt/[paymentId] — printable payment receipt payload.
 * Works for every payment: front-desk folio payments, group master advances,
 * and per-room auto-split allocations (the "Group <code> auto-split"
 * reference on those identifies the group billing context).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { paymentId } = await params;

  const payment = await db.payment.findFirst({
    where: { id: paymentId, propertyId },
    include: {
      reservation: {
        include: {
          property: { select: { name: true, address: true, city: true, gstin: true, phone: true } },
          guest: { select: { fullName: true, phone: true, email: true, address: true, city: true } },
          room: { select: { number: true, roomType: { select: { name: true } } } },
        },
      },
    },
  });
  if (!payment || !payment.reservation) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const reservation = payment.reservation;
  const agg = await db.folioItem.aggregate({ where: { reservationId: reservation.id }, _sum: { amount: true } });
  const charges = round2(agg._sum.amount ?? 0);
  const paid = round2(reservation.paidAmount);
  const priorPaid = round2(paid - payment.amount);

  // Advance/credit detection: this payment pushed the folio past its charges
  const isAdvance = priorPaid >= charges && payment.amount > 0;

  return NextResponse.json({
    receipt: {
      receiptNo: `RCP-${payment.id.slice(-8).toUpperCase()}`,
      date: payment.createdAt,
      amount: round2(payment.amount),
      method: payment.method,
      reference: payment.reference,
      receivedBy: payment.receivedBy,
      isAdvance,
      hotel: reservation.property,
      guest: reservation.guest,
      reservation: {
        id: reservation.id,
        confirmationNumber: reservation.confirmationNumber,
        status: reservation.status,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        nights: reservation.nights,
        groupCode: reservation.groupCode,
        room: reservation.room
          ? { number: reservation.room.number, roomTypeName: reservation.room.roomType.name }
          : null,
      },
      totals: { charges, paid, balance: round2(charges - paid) },
    },
  });
}
