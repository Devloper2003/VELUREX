import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { createTaskFromData, sortTasks, taskInclude } from "../_shared";

/** GET /api/housekeeping/tasks?status=&roomId=&assignedTo= */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const roomId = searchParams.get("roomId") || undefined;
  const assignedTo = searchParams.get("assignedTo") || undefined;

  const tasks = await db.housekeepingTask.findMany({
    where: {
      propertyId,
      ...(status ? { status } : {}),
      ...(roomId ? { roomId } : {}),
      ...(assignedTo ? { assignedTo } : {}),
    },
    include: taskInclude,
  });

  return NextResponse.json({ tasks: sortTasks(tasks) });
}

/** POST /api/housekeeping/tasks — idempotent on propertyId + clientRef (offline replay safety). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    roomId?: unknown;
    taskType?: unknown;
    priority?: unknown;
    dueAt?: unknown;
    notes?: unknown;
    assignedTo?: unknown;
    clientRef?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const clientRef = typeof body.clientRef === "string" ? body.clientRef : "";

  // Idempotency: same propertyId + clientRef → return the original task (200, no duplicate).
  if (clientRef) {
    const existing = await db.housekeepingTask.findFirst({
      where: { propertyId, clientRef },
      include: taskInclude,
    });
    if (existing) return NextResponse.json({ task: existing, deduped: true });
  }

  try {
    const task = await createTaskFromData(propertyId, body, clientRef);
    await logActivity({
      propertyId,
      staffId: session.sub,
      staffName: session.name,
      action: "TASK_CREATE",
      entity: "HousekeepingTask",
      entityId: task.id,
      details: `Room ${task.room.number} · ${task.taskType} · ${task.priority}`,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create task" },
      { status: 400 }
    );
  }
}
