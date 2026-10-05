import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const PAYMENT_METHODS = ["cash", "upi", "card", "netbanking", "razorpay"];
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A method outside the base list is accepted when it matches an ENABLED online
 * payment gateway the software owner assigned to this property.
 */
async function isValidMethod(propertyId: string, method: string): Promise<boolean> {
  if (PAYMENT_METHODS.includes(method)) return true;
  const gw = await db.paymentGateway.findFirst({
    where: { propertyId, enabled: true, provider: method },
    select: { id: true },
  });
  return Boolean(gw);
}

/**
 * GET /api/payments?reservationId= — payments for a reservation, newest first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const reservationId = req.nextUrl.searchParams.get("reservationId");
  if (!reservationId) {
    return NextResponse.json({ error: "reservationId query param is required" }, { status: 400 });
  }

  const reservation = await db.reservation.findFirst({ where: { id: reservationId, propertyId } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });

  const payments = await db.payment.findMany({
    where: { reservationId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ payments });
}

/**
 * POST /api/payments — record a payment against a reservation.
 * Body: { reservationId, amount, method, reference? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const reservationId = typeof body.reservationId === "string" ? body.reservationId : "";
  const method = typeof body.method === "string" ? body.method : "";
  const amount = Number(body.amount);
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";

  if (!reservationId) return NextResponse.json({ error: "reservationId is required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
  }
  if (!PAYMENT_METHODS.includes(method) && !(await isValidMethod(propertyId, method))) {
    return NextResponse.json(
      { error: `Invalid method — must be one of: ${PAYMENT_METHODS.join(", ")} or an enabled gateway provider` },
      { status: 400 }
    );
  }

  const reservation = await db.reservation.findFirst({ where: { id: reservationId, propertyId } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });

  // Offline-sync idempotency: a replayed queued payment returns the original record.
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.trim() : "";
  if (clientRef) {
    const existing = await db.payment.findFirst({
      where: { propertyId, reservationId, clientRef },
      select: { id: true },
    });
    if (existing) {
      const payment = await db.payment.findUnique({ where: { id: existing.id } });
      const agg = await db.folioItem.aggregate({ where: { reservationId }, _sum: { amount: true } });
      const charges = round2(agg._sum.amount ?? 0);
      const paid = round2(reservation.paidAmount);
      return NextResponse.json(
        { payment, totals: { charges, paid, balance: round2(charges - paid) }, idempotentReplay: true }
      );
    }
  }

  const [payment, updatedReservation] = await db.$transaction([
    db.payment.create({
      data: {
        propertyId,
        reservationId,
        amount: round2(amount),
        method,
        status: "success",
        reference,
        receivedBy: auth.session.name,
        clientRef,
      },
    }),
    db.reservation.update({
      where: { id: reservationId },
      data: { paidAmount: { increment: round2(amount) } },
    }),
  ]);

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "PAYMENT_RECORD",
    entity: "payment",
    entityId: payment.id,
    details: `₹${payment.amount.toFixed(2)} via ${method.toUpperCase()}${reference ? ` · ref ${reference}` : ""} → ${reservation.confirmationNumber}`,
  });

  // Folio-item sums are the authoritative charge total
  const agg = await db.folioItem.aggregate({ where: { reservationId }, _sum: { amount: true } });
  const charges = round2(agg._sum.amount ?? 0);
  const paid = round2(updatedReservation.paidAmount);

  return NextResponse.json(
    { payment, totals: { charges, paid, balance: round2(charges - paid) } },
    { status: 201 }
  );
}
