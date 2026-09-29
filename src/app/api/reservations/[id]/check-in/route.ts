import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/business";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/reservations/[id]/check-in — check a guest in.
 * Body: { idType?, idNumber?, idProofData? (data URL) }
 * Requires status confirmed|hold; marks the room occupied and captures ID proof.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  const reservation = await db.reservation.findFirst({
    where: { id, propertyId },
    include: { guest: true, room: { include: { roomType: true } } },
  });
  if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  if (!["confirmed", "hold"].includes(reservation.status))
    return NextResponse.json(
      { error: `Only confirmed or hold reservations can be checked in (current status: ${reservation.status.replace("_", " ")})` },
      { status: 409 }
    );
  if (!reservation.roomId)
    return NextResponse.json({ error: "Assign a room to this reservation before check-in" }, { status: 409 });

  const body = await req.json().catch(() => ({}));

  const idType = body?.idType !== undefined ? String(body.idType) : reservation.idType;
  const idNumber = body?.idNumber !== undefined ? String(body.idNumber) : reservation.idNumber;
  const idProofData = body?.idProofData !== undefined ? String(body.idProofData) : reservation.idProofData;

  // Guard against double-occupancy of the same room.
  const occupiedByOther = await db.reservation.findFirst({
    where: { propertyId, roomId: reservation.roomId, status: "checked_in", id: { not: id } },
    select: { confirmationNumber: true },
  });
  if (occupiedByOther)
    return NextResponse.json(
      { error: `Room is already occupied by ${occupiedByOther.confirmationNumber}` },
      { status: 409 }
    );

  const now = new Date();

  const [updated] = await db.$transaction([
    db.reservation.update({
      where: { id },
      data: { status: "checked_in", checkedInAt: now, idType, idNumber, idProofData },
      include: {
        guest: { select: { id: true, fullName: true, phone: true, email: true } },
        room: { include: { roomType: { select: { name: true, code: true } } } },
        roomType: { select: { name: true, code: true } },
      },
    }),
    db.room.update({ where: { id: reservation.roomId }, data: { status: "occupied" } }),
    // Backfill the guest profile if ID details were empty there.
    db.guest.update({
      where: { id: reservation.guestId },
      data: {
        ...(idType && !reservation.guest.idType ? { idType } : {}),
        ...(idNumber && !reservation.guest.idNumber ? { idNumber } : {}),
      },
    }),
  ]);

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHECK_IN",
    entity: "Reservation",
    entityId: id,
    details: `Checked in ${reservation.guest.fullName} — room ${reservation.room?.number ?? "?"} (${reservation.confirmationNumber})${idType ? ` · ID: ${idType}` : ""}${idProofData ? " · ID proof captured" : ""}`,
  });

  return NextResponse.json({ reservation: updated });
}
