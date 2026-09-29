import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";
import { performCheckout } from "@/lib/checkout-core";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * POST /api/groups/[code]/check-out — bulk group check-out.
 *
 * Checks out every in-house member of the group in one shot, reusing the
 * single check-out engine (early-departure re-pricing, departure posting of
 * unbilled nights, promo reconciliation, room → dirty). Members with a
 * non-zero balance still check out — the balance stays on their folio for
 * settlement (the UI surfaces the total outstanding so the desk can collect).
 * One failure never blocks the rest; a per-member result list is returned.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: {
      guest: { select: { fullName: true } },
      room: { select: { number: true } },
    },
    orderBy: [{ room: { number: "asc" } }, { createdAt: "asc" }],
  });
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  const inHouse = members.filter((m) => m.status === "checked_in");
  if (inHouse.length === 0) {
    return NextResponse.json(
      { error: "No in-house members to check out — every room is already checked out, cancelled or no-show" },
      { status: 409 }
    );
  }

  const results: {
    reservationId: string;
    confirmationNumber: string;
    guestName: string;
    roomNumber: string | null;
    result: "checked_out" | "skipped" | "error";
    reason?: string;
    folioTotal?: number;
    paid?: number;
    balance?: number;
    earlyDeparture?: { bookedNights: number; stayedNights: number } | null;
  }[] = [];

  for (const m of members) {
    if (m.status !== "checked_in") {
      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: m.guest.fullName,
        roomNumber: m.room?.number ?? null,
        result: "skipped",
        reason:
          m.status === "checked_out"
            ? "Already checked out"
            : `Cannot check out a ${m.status.replace("_", " ")} reservation`,
      });
      continue;
    }
    try {
      const outcome = await performCheckout({
        propertyId,
        reservationId: m.id,
        staff: { sub: auth.session.sub, name: auth.session.name },
      });
      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: outcome.guestName,
        roomNumber: outcome.roomNumber,
        result: "checked_out",
        folioTotal: outcome.folioTotal,
        paid: outcome.paid,
        balance: outcome.balance,
        earlyDeparture: outcome.earlyDeparture
          ? { bookedNights: outcome.earlyDeparture.bookedNights, stayedNights: outcome.earlyDeparture.stayedNights }
          : null,
      });
    } catch (e) {
      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: m.guest.fullName,
        roomNumber: m.room?.number ?? null,
        result: "error",
        reason: ((e as Error).message || "Unexpected failure").slice(0, 160),
      });
    }
  }

  const checkedOut = results.filter((r) => r.result === "checked_out");
  const skipped = results.filter((r) => r.result === "skipped").length;
  const failed = results.filter((r) => r.result === "error").length;
  const totalOutstanding = round2(
    checkedOut.reduce((s, r) => s + Math.max(0, r.balance ?? 0), 0)
  );
  const totalCredit = round2(
    checkedOut.reduce((s, r) => s + Math.min(0, r.balance ?? 0), 0)
  );

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GROUP_CHECK_OUT",
    entity: "reservation",
    entityId: checkedOut[0]?.reservationId ?? groupCode,
    details: `Group ${groupCode}: bulk check-out — ${checkedOut.length} room(s) checked out, ${skipped} skipped, ${failed} failed · outstanding ₹${totalOutstanding.toFixed(2)}${totalCredit < 0 ? ` · credit ₹${Math.abs(totalCredit).toFixed(2)}` : ""}`,
  });

  return NextResponse.json({
    checkedOut: checkedOut.length,
    skipped,
    failed,
    totalOutstanding,
    totalCredit,
    results,
  });
}
