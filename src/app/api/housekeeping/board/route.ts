import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/housekeeping/board — rooms grouped by floor with guest + active task,
 * built from one efficient parallel query set (rooms / in-house guests / open tasks).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const [rooms, inHouse, openTasks] = await Promise.all([
    db.room.findMany({
      where: { propertyId },
      include: { roomType: { select: { name: true } } },
      orderBy: [{ floor: "asc" }, { number: "asc" }],
    }),
    db.reservation.findMany({
      where: { propertyId, status: "checked_in", roomId: { not: null } },
      select: { roomId: true, guest: { select: { fullName: true } } },
    }),
    db.housekeepingTask.findMany({
      where: { propertyId, status: { in: ["pending", "in_progress", "blocked"] } },
      include: { assignedToStaff: { select: { name: true } } },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const guestByRoom = new Map<string, string>();
  for (const res of inHouse) {
    if (res.roomId && !guestByRoom.has(res.roomId)) guestByRoom.set(res.roomId, res.guest.fullName);
  }

  // Most relevant task per room: in_progress > pending > blocked, first by dueAt.
  const rank: Record<string, number> = { in_progress: 0, pending: 1, blocked: 2 };
  const taskByRoom = new Map<string, (typeof openTasks)[number]>();
  for (const t of openTasks) {
    const current = taskByRoom.get(t.roomId);
    if (!current || (rank[t.status] ?? 9) < (rank[current.status] ?? 9)) {
      taskByRoom.set(t.roomId, t);
    }
  }

  const floors = [...new Set(rooms.map((r) => r.floor))]
    .sort((a, b) => a - b)
    .map((floor) => ({
      floor,
      rooms: rooms
        .filter((r) => r.floor === floor)
        .map((r) => {
          const t = taskByRoom.get(r.id);
          return {
            id: r.id,
            number: r.number,
            floor: r.floor,
            status: r.status,
            note: r.note,
            roomTypeName: r.roomType.name,
            currentGuest: guestByRoom.get(r.id) ?? null,
            activeTask: t
              ? {
                  id: t.id,
                  taskType: t.taskType,
                  status: t.status,
                  priority: t.priority,
                  assignedToName: t.assignedToStaff?.name ?? null,
                }
              : null,
          };
        }),
    }));

  const byStatus = (s: string) => rooms.filter((r) => r.status === s).length;

  return NextResponse.json({
    floors,
    counts: {
      total: rooms.length,
      vacant: byStatus("vacant"),
      occupied: byStatus("occupied"),
      dirty: byStatus("dirty"),
      clean: byStatus("clean"),
      outOfOrder: byStatus("out_of_order"),
      openTasks: openTasks.length,
    },
  });
}
