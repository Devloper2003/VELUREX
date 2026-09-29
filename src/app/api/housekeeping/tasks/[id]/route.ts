import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { applyTaskUpdate } from "../../_shared";

/** PATCH /api/housekeeping/tasks/[id] — partial update {status?, assignedTo?, priority?, dueAt?, notes?} */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  try {
    const task = await applyTaskUpdate(propertyId, id, body);
    await logActivity({
      propertyId,
      staffId: session.sub,
      staffName: session.name,
      action: "TASK_UPDATE",
      entity: "HousekeepingTask",
      entityId: task.id,
      details: `Room ${task.room.number} · ${task.status}${task.assignedToStaff ? ` · ${task.assignedToStaff.name}` : ""}`,
    });
    return NextResponse.json({ task });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not update task";
    const notFound = msg === "Task not found";
    return NextResponse.json({ error: msg }, { status: notFound ? 404 : 400 });
  }
}
