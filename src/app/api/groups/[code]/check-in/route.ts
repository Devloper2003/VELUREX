import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";

/**
 * POST /api/groups/[code]/check-in — bulk group check-in.
 *
 * Checks in every hold/confirmed member of the group in one shot:
 *  - members with a room assigned → checked straight in (room → occupied)
 *  - members without a room → auto-assigned a free room, preferring the
 *    booked room type ("vacant"/"clean" only — never dirty/occupied/OOO),
 *    falling back to any free room (reported as a room move)
 *  - already in-house members are skipped, failed members don't block the rest
 *
 * Returns a per-member result list so the UI can show exactly what happened.
 */

const ASSIGNABLE_ROOM_STATUSES = ["vacant", "clean"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const allowDirty = body?.allowDirty === true; // explicit opt-in to check into uncleaned rooms

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: {
      guest: { select: { fullName: true } },
      room: { select: { id: true, number: true, status: true } },
    },
    orderBy: [{ room: { number: "asc" } }, { createdAt: "asc" }],
  });
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  const results: {
    reservationId: string;
    confirmationNumber: string;
    guestName: string;
    roomNumber: string | null;
    result: "checked_in" | "skipped" | "error";
    reason?: string;
    roomMoved?: boolean;
  }[] = [];

  const inHouseNow = members.filter((m) => m.status === "checked_in").length;

  for (const m of members) {
    const label = `${m.guest.fullName} (${m.room?.number ?? m.confirmationNumber})`;
    if (!["hold", "confirmed"].includes(m.status)) {
      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: m.guest.fullName,
        roomNumber: m.room?.number ?? null,
        result: "skipped",
        reason:
          m.status === "checked_in"
            ? "Already in-house"
            : m.status === "checked_out"
              ? "Already checked out"
              : `Cannot check in a ${m.status.replace("_", " ")} reservation`,
      });
      continue;
    }

    try {
      let roomId = m.roomId;
      let roomNumber = m.room?.number ?? null;
      let roomMoved = false;

      // Auto-assign a free room when the member has none.
      if (!roomId) {
        const bookedTypeId = m.roomTypeId;
        let pool = await db.room.findMany({
          where: {
            propertyId,
            status: { in: allowDirty ? [...ASSIGNABLE_ROOM_STATUSES, "dirty"] : ASSIGNABLE_ROOM_STATUSES },
            ...(bookedTypeId ? { roomTypeId: bookedTypeId } : {}),
          },
          orderBy: [{ number: "asc" }],
          take: 10,
        });
        if (pool.length === 0) {
          // Fall back to any free room (room-type move)
          pool = await db.room.findMany({
            where: { propertyId, status: { in: allowDirty ? [...ASSIGNABLE_ROOM_STATUSES, "dirty"] : ASSIGNABLE_ROOM_STATUSES } },
            orderBy: [{ number: "asc" }],
            take: 10,
          });
          if (pool.length === 0) {
            results.push({
              reservationId: m.id,
              confirmationNumber: m.confirmationNumber,
              guestName: m.guest.fullName,
              roomNumber: null,
              result: "error",
              reason: "No free room available — clean rooms or release housekeeping holds first",
            });
            continue;
          }
          roomMoved = true;
        }
        // Skip rooms already occupied by an active booking in this pass
        const candidate = await pickFreeRoom(propertyId, pool);
        if (!candidate) {
          results.push({
            reservationId: m.id,
            confirmationNumber: m.confirmationNumber,
            guestName: m.guest.fullName,
            roomNumber: null,
            result: "error",
            reason: "No free room available",
          });
          continue;
        }
        await db.reservation.update({ where: { id: m.id }, data: { roomId: candidate.id } });
        roomId = candidate.id;
        roomNumber = candidate.number;
        roomMoved = roomMoved || true;
      }

      // Double-occupancy guard (same semantics as single check-in): if the
      // assigned room is currently held by another active booking (sequential
      // back-to-back bookings of the same room are normal), try to move this
      // member to a free room instead of failing the whole group arrival.
      const occupiedByOther = await db.reservation.findFirst({
        where: { propertyId, roomId, status: "checked_in", id: { not: m.id } },
        select: { confirmationNumber: true },
      });
      if (occupiedByOther) {
        const movePool = await db.room.findMany({
          where: {
            propertyId,
            status: { in: ASSIGNABLE_ROOM_STATUSES },
            ...(m.roomTypeId ? { roomTypeId: m.roomTypeId } : {}),
          },
          orderBy: [{ number: "asc" }],
          take: 10,
        });
        const alt = await pickFreeRoom(propertyId, movePool);
        if (!alt) {
          results.push({
            reservationId: m.id,
            confirmationNumber: m.confirmationNumber,
            guestName: m.guest.fullName,
            roomNumber,
            result: "error",
            reason: `Room ${roomNumber} is occupied by ${occupiedByOther.confirmationNumber} and no comparable room is free — check in after departure or assign another room manually`,
          });
          continue;
        }
        await db.reservation.update({ where: { id: m.id }, data: { roomId: alt.id } });
        roomId = alt.id;
        roomNumber = alt.number;
        roomMoved = true;
      }

      const now = new Date();
      await db.$transaction([
        db.reservation.update({
          where: { id: m.id },
          data: { status: "checked_in", checkedInAt: now },
        }),
        db.room.update({ where: { id: roomId }, data: { status: "occupied" } }),
      ]);

      emitRealtime("global", "folio:update", { reservationId: m.id, kind: "group-check-in" });

      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: m.guest.fullName,
        roomNumber,
        result: "checked_in",
        ...(roomMoved ? { reason: `Moved to Room ${roomNumber} — booked room unavailable` } : {}),
      });
    } catch (e) {
      results.push({
        reservationId: m.id,
        confirmationNumber: m.confirmationNumber,
        guestName: m.guest.fullName,
        roomNumber: m.room?.number ?? null,
        result: "error",
        reason: (e as Error).message?.slice(0, 160) || "Unexpected failure",
      });
    }
  }

  const checkedIn = results.filter((r) => r.result === "checked_in").length;
  const skipped = results.filter((r) => r.result === "skipped").length;
  const failed = results.filter((r) => r.result === "error").length;

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GROUP_CHECK_IN",
    entity: "reservation",
    entityId: results[0]?.reservationId ?? groupCode,
    details: `Group ${groupCode}: bulk check-in — ${checkedIn} room(s) checked in, ${skipped} skipped, ${failed} failed (in-house now ${inHouseNow + checkedIn})`,
  });

  return NextResponse.json({
    checkedIn,
    skipped,
    failed,
    results,
  });
}

/** First candidate room with no other active booking holding it. */
async function pickFreeRoom(propertyId: string, pool: { id: string; number: string }[]) {
  for (const room of pool) {
    const occupied = await db.reservation.findFirst({
      where: { propertyId, roomId: room.id, status: "checked_in" },
      select: { id: true },
    });
    if (!occupied) return room;
  }
  return null;
}
