import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const TICKET_STATUSES = ["open", "in_progress", "resolved"];
const TICKET_PRIORITIES = ["low", "normal", "high"];

/** PATCH /api/maintenance/[id] — { status?, priority? }; status→resolved stamps resolvedAt. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as {
    status?: unknown;
    priority?: unknown;
    clientRef?: unknown; // ignored
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const ticket = await db.maintenanceTicket.findFirst({
    where: { id, propertyId },
    include: { room: { select: { number: true } } },
  });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const data: { status?: string; resolvedAt?: Date | null; priority?: string } = {};

  if (body.status !== undefined) {
    const status = typeof body.status === "string" ? body.status : "";
    if (!TICKET_STATUSES.includes(status)) {
      return NextResponse.json({ error: `status must be one of: ${TICKET_STATUSES.join(", ")}` }, { status: 400 });
    }
    data.status = status;
    data.resolvedAt = status === "resolved" ? new Date() : null;
  }

  if (body.priority !== undefined) {
    const priority = typeof body.priority === "string" ? body.priority : "";
    if (!TICKET_PRIORITIES.includes(priority)) {
      return NextResponse.json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` }, { status: 400 });
    }
    data.priority = priority;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await db.maintenanceTicket.update({
    where: { id },
    data,
    include: { room: { select: { number: true } } },
  });

  await logActivity({
    propertyId,
    staffId: session.sub,
    staffName: session.name,
    action: "MAINTENANCE_UPDATE",
    entity: "MaintenanceTicket",
    entityId: id,
    details: `Room ${updated.room?.number ?? "—"} · ${updated.title} · ${updated.status}`,
  });

  return NextResponse.json({ ticket: updated });
}
