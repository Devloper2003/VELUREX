import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** GET /api/owner/tickets/[id] — ticket + full thread (internal notes included). */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const ticket = await db.supportTicket.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, city: true, subscriptionStatus: true, currentPlanId: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const plan = ticket.property.currentPlanId
    ? await db.plan.findUnique({ where: { id: ticket.property.currentPlanId }, select: { name: true, code: true } })
    : null;

  return NextResponse.json({
    ticket: {
      id: ticket.id, subject: ticket.subject, category: ticket.category, priority: ticket.priority,
      status: ticket.status, createdByName: ticket.createdByName, assignedTo: ticket.assignedTo,
      firstResponseAt: ticket.firstResponseAt, resolvedAt: ticket.resolvedAt, createdAt: ticket.createdAt,
      property: { ...ticket.property, planName: plan?.name ?? "—" },
    },
    messages: ticket.messages,
  });
}

/**
 * PATCH /api/owner/tickets/[id] — reply (public or internal note), assign,
 * change status/priority.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const ticket = await db.supportTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "reply");

  if (action === "reply") {
    const text = String(body.body ?? "").trim();
    if (!text) return NextResponse.json({ error: "Message body is required" }, { status: 400 });
    const internal = Boolean(body.internal);
    await db.ticketMessage.create({
      data: {
        ticketId: id, authorType: "platform", authorName: owner.email, body: text, internal,
      },
    });
    await db.supportTicket.update({
      where: { id },
      data: {
        firstResponseAt: ticket.firstResponseAt ?? new Date(),
        status: internal ? ticket.status : "waiting",
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "assign") {
    const assignedTo = String(body.assignedTo ?? owner.email);
    await db.supportTicket.update({ where: { id }, data: { assignedTo } });
    await logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: "TICKET_ASSIGNED",
      entity: "ticket", entityId: id, propertyId: ticket.propertyId,
      details: `"${ticket.subject}" assigned to ${assignedTo}`,
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "status") {
    const status = ["open", "in_progress", "waiting", "resolved", "closed"].includes(String(body.status))
      ? String(body.status) : ticket.status;
    await db.supportTicket.update({
      where: { id },
      data: { status, resolvedAt: ["resolved", "closed"].includes(status) ? new Date() : null },
    });
    await logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: "TICKET_STATUS",
      entity: "ticket", entityId: id, propertyId: ticket.propertyId,
      details: `"${ticket.subject}" → ${status}`,
    });
    return NextResponse.json({ ok: true, status });
  }

  if (action === "priority") {
    const priority = ["low", "normal", "high", "urgent"].includes(String(body.priority))
      ? String(body.priority) : ticket.priority;
    await db.supportTicket.update({ where: { id }, data: { priority } });
    return NextResponse.json({ ok: true, priority });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
