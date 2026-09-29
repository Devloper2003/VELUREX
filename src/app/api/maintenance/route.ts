import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const TICKET_STATUSES = ["open", "in_progress", "resolved"];
const TICKET_PRIORITIES = ["low", "normal", "high"];

const ticketInclude = { room: { select: { number: true } } } as const;

/** GET /api/maintenance?status= — tickets newest first. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;

  const tickets = await db.maintenanceTicket.findMany({
    where: { propertyId, ...(status ? { status } : {}) },
    include: ticketInclude,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ tickets });
}

/** POST /api/maintenance — { roomId?, title, description?, priority?, photoUrl? } */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    roomId?: unknown;
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    photoUrl?: unknown;
    clientRef?: unknown; // ignored (offline mutate() injects it)
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const priority = typeof body.priority === "string" && body.priority ? body.priority : "normal";
  if (!TICKET_PRIORITIES.includes(priority)) {
    return NextResponse.json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` }, { status: 400 });
  }

  let roomId: string | null = null;
  let roomNumber = "—";
  if (typeof body.roomId === "string" && body.roomId) {
    const room = await db.room.findFirst({ where: { id: body.roomId, propertyId } });
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    roomId = room.id;
    roomNumber = room.number;
  }

  const ticket = await db.maintenanceTicket.create({
    data: {
      propertyId,
      roomId,
      title,
      description: typeof body.description === "string" ? body.description : "",
      priority,
      photoUrl: typeof body.photoUrl === "string" ? body.photoUrl : "",
      reportedBy: session.name,
    },
    include: ticketInclude,
  });

  await logActivity({
    propertyId,
    staffId: session.sub,
    staffName: session.name,
    action: "MAINTENANCE_CREATE",
    entity: "MaintenanceTicket",
    entityId: ticket.id,
    details: `Room ${roomNumber} · ${title} · ${priority}`,
  });

  return NextResponse.json({ ticket }, { status: 201 });
}
