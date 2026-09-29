import { db } from "@/lib/db";

/**
 * Shared validation + mutation helpers for housekeeping tasks.
 * Used by /api/housekeeping/tasks (POST), /api/housekeeping/tasks/[id] (PATCH)
 * and /api/housekeeping/sync (offline batch replay) so every path applies
 * exactly the same rules.
 */

export const TASK_TYPES = ["cleaning", "linen_change", "bathroom", "inspection", "turndown"];
export const TASK_PRIORITIES = ["low", "normal", "high"];
export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"];
export const ROOM_STATUSES = ["vacant", "occupied", "dirty", "clean", "out_of_order"];

/** Display ordering: pending → in_progress → blocked → completed. */
export const STATUS_ORDER: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  blocked: 2,
  completed: 3,
};

export const taskInclude = {
  room: { select: { number: true, floor: true, status: true } },
  assignedToStaff: { select: { name: true } },
} as const;

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface CreateTaskData {
  roomId?: unknown;
  taskType?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  notes?: unknown;
  assignedTo?: unknown;
}

/**
 * Validate + create a housekeeping task. Throws Error(message) with a
 * user-facing message on invalid input (caught by callers / sync loop).
 */
export async function createTaskFromData(propertyId: string, raw: CreateTaskData, clientRef: string) {
  const roomId = asString(raw.roomId);
  if (!roomId) throw new Error("roomId is required");

  const room = await db.room.findFirst({ where: { id: roomId, propertyId } });
  if (!room) throw new Error("Room not found");

  const taskType = asString(raw.taskType) || "cleaning";
  if (!(TASK_TYPES as readonly string[]).includes(taskType)) {
    throw new Error(`taskType must be one of: ${TASK_TYPES.join(", ")}`);
  }

  const priority = asString(raw.priority) || "normal";
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
  }

  let assignedTo: string | null = null;
  const assignee = asString(raw.assignedTo);
  if (assignee) {
    const staff = await db.staff.findFirst({ where: { id: assignee, propertyId, active: true } });
    if (!staff) throw new Error("Assigned staff not found");
    assignedTo = staff.id;
  }

  let dueAt: Date | null = null;
  const due = raw.dueAt;
  if (typeof due === "string" && due !== "") {
    const parsed = new Date(due);
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid dueAt");
    dueAt = parsed;
  }

  return db.housekeepingTask.create({
    data: {
      propertyId,
      roomId,
      taskType,
      priority,
      dueAt,
      notes: asString(raw.notes) ?? "",
      assignedTo,
      clientRef,
    },
    include: taskInclude,
  });
}

export interface UpdateTaskData {
  status?: unknown;
  priority?: unknown;
  assignedTo?: unknown;
  dueAt?: unknown;
  notes?: unknown;
}

/**
 * Validate + apply a partial update to a task. status→completed stamps
 * completedAt; moving out of completed clears it. Throws Error(message).
 */
export async function applyTaskUpdate(propertyId: string, taskId: string, raw: UpdateTaskData) {
  const task = await db.housekeepingTask.findFirst({ where: { id: taskId, propertyId } });
  if (!task) throw new Error("Task not found");

  const data: {
    status?: string;
    completedAt?: Date | null;
    priority?: string;
    assignedTo?: string | null;
    dueAt?: Date | null;
    notes?: string;
  } = {};

  const status = asString(raw.status);
  if (status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
    }
    data.status = status;
    data.completedAt = status === "completed" ? new Date() : null;
  }

  const priority = asString(raw.priority);
  if (priority !== undefined) {
    if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
      throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
    }
    data.priority = priority;
  }

  const assignedTo = raw.assignedTo;
  if (assignedTo !== undefined) {
    if (assignedTo === null || assignedTo === "") {
      data.assignedTo = null;
    } else if (typeof assignedTo === "string") {
      const staff = await db.staff.findFirst({ where: { id: assignedTo, propertyId, active: true } });
      if (!staff) throw new Error("Assigned staff not found");
      data.assignedTo = staff.id;
    } else {
      throw new Error("Invalid assignedTo value");
    }
  }

  const dueAt = raw.dueAt;
  if (dueAt !== undefined) {
    if (dueAt === null || dueAt === "") {
      data.dueAt = null;
    } else if (typeof dueAt === "string") {
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid dueAt");
      data.dueAt = parsed;
    } else {
      throw new Error("Invalid dueAt");
    }
  }

  const notes = asString(raw.notes);
  if (notes !== undefined) data.notes = notes;

  if (Object.keys(data).length === 0) throw new Error("Nothing to update");

  return db.housekeepingTask.update({ where: { id: taskId }, data, include: taskInclude });
}

/** Sort tasks: pending (dueAt asc) → in_progress → blocked → completed (completedAt desc). */
export function sortTasks<T extends { status: string; dueAt: Date | string | null; completedAt: Date | string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 9;
    const ob = STATUS_ORDER[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    if (a.status === "completed") {
      return new Date(b.completedAt ?? b.dueAt ?? 0).getTime() - new Date(a.completedAt ?? a.dueAt ?? 0).getTime();
    }
    const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const dbv = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return da - dbv;
  });
}
