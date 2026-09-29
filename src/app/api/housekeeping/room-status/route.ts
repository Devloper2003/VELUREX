import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { ROOM_STATUSES } from "../_shared";

/**
 * POST /api/housekeeping/room-status — { roomId, status, note? }
 * Updates room status (housekeeping may do this offline via mutate()).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    roomId?: unknown;
    status?: unknown;
    note?: unknown;
    clientRef?: unknown; // injected by offline mutate(); ignored
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const roomId = typeof body.roomId === "string" ? body.roomId : "";
  const status = typeof body.status === "string" ? body.status : "";
  const note = typeof body.note === "string" ? body.note : undefined;

  if (!roomId) return NextResponse.json({ error: "roomId is required" }, { status: 400 });
  if (!(ROOM_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${ROOM_STATUSES.join(", ")}` }, { status: 400 });
  }

  const room = await db.room.findFirst({ where: { id: roomId, propertyId } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const data: { status: string; note?: string } = { status };
  if (note !== undefined) {
    data.note = note;
  } else if (status !== "out_of_order" && room.status === "out_of_order") {
    // Leaving out-of-order without a new note clears the stale repair note.
    data.note = "";
  }

  const updated = await db.room.update({
    where: { id: roomId },
    data,
    include: { roomType: { select: { name: true } } },
  });

  await logActivity({
    propertyId,
    staffId: session.sub,
    staffName: session.name,
    action: "ROOM_STATUS",
    entity: "Room",
    entityId: roomId,
    details: `Room ${room.number}: ${room.status} → ${status}${data.note ? ` · ${data.note}` : ""}`,
  });

  return NextResponse.json({
    room: {
      id: updated.id,
      number: updated.number,
      floor: updated.floor,
      status: updated.status,
      note: updated.note,
      roomTypeName: updated.roomType.name,
    },
  });
}
