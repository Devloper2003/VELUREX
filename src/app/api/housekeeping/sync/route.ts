import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { applyTaskUpdate, createTaskFromData } from "../_shared";

interface SyncOperation {
  clientRef?: unknown;
  kind?: unknown; // "create" | "update"
  taskId?: unknown;
  data?: Record<string, unknown>;
}

interface SyncResult {
  clientRef: string;
  ok: boolean;
  taskId?: string;
  deduped?: boolean;
  error?: string;
}

/**
 * POST /api/housekeeping/sync — offline batch replay.
 * Body: { operations: [{ clientRef, kind: "create"|"update", taskId?, data }] }
 * Create ops dedupe on propertyId + clientRef; update ops apply partial changes.
 * Individual failures NEVER fail the whole request — every op reports per-op.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;

  const body = (await req.json().catch(() => null)) as { operations?: SyncOperation[] } | null;
  if (!body || !Array.isArray(body.operations)) {
    return NextResponse.json({ error: "Body must be { operations: [...] }" }, { status: 400 });
  }

  const results: SyncResult[] = [];

  for (const op of body.operations) {
    const clientRef = typeof op?.clientRef === "string" ? op.clientRef : "";
    try {
      if (!clientRef) throw new Error("clientRef is required");

      if (op.kind === "create") {
        // Dedupe first: a previous replay (or retry) may have created it already.
        const existing = await dbByRef(propertyId, clientRef);
        if (existing) {
          results.push({ clientRef, ok: true, taskId: existing.id, deduped: true });
          continue;
        }
        const task = await createTaskFromData(propertyId, op.data || {}, clientRef);
        await logActivity({
          propertyId,
          staffId: session.sub,
          staffName: session.name,
          action: "TASK_CREATE",
          entity: "HousekeepingTask",
          entityId: task.id,
          details: `Room ${task.room.number} · ${task.taskType} · synced from offline`,
        });
        results.push({ clientRef, ok: true, taskId: task.id });
      } else if (op.kind === "update") {
        let taskId = typeof op.taskId === "string" ? op.taskId : "";
        if (!taskId) {
          const byRef = await dbByRef(propertyId, clientRef);
          if (!byRef) throw new Error("taskId required (no task matches clientRef)");
          taskId = byRef.id;
        }
        const data = op.data || {};
        const task = await applyTaskUpdate(propertyId, taskId, data);
        await logActivity({
          propertyId,
          staffId: session.sub,
          staffName: session.name,
          action: "TASK_UPDATE",
          entity: "HousekeepingTask",
          entityId: task.id,
          details: `Room ${task.room.number} · ${task.status} · synced from offline (${Object.keys(data).join(", ")})`,
        });
        results.push({ clientRef, ok: true, taskId: task.id });
      } else {
        throw new Error(`Unknown kind "${String(op.kind)}" — expected "create" or "update"`);
      }
    } catch (e) {
      results.push({
        clientRef,
        ok: false,
        error: e instanceof Error ? e.message : "Operation failed",
      });
    }
  }

  return NextResponse.json({ results });
}

function dbByRef(propertyId: string, clientRef: string) {
  return db.housekeepingTask.findFirst({ where: { propertyId, clientRef } });
}
