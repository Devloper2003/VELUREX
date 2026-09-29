import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * POST /api/subscription/tickets — tenant-side "Raise ticket" (hotel admin).
 * Body: { subject, category?, priority?, body }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const propertyId = session.propertyId;
  if (!propertyId) return NextResponse.json({ error: "No tenant context" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const subject = String(body.subject ?? "").trim();
  const text = String(body.body ?? "").trim();
  if (!subject || !text)
    return NextResponse.json({ error: "Subject and description are required" }, { status: 400 });

  const property = await db.property.findUnique({ where: { id: propertyId }, select: { name: true } });

  const ticket = await db.supportTicket.create({
    data: {
      propertyId,
      subject,
      category: ["general", "billing", "technical", "feature_request"].includes(String(body.category))
        ? String(body.category) : "general",
      priority: ["low", "normal", "high", "urgent"].includes(String(body.priority))
        ? String(body.priority) : "normal",
      createdById: session.sub,
      createdByName: session.name,
    },
  });
  await db.ticketMessage.create({
    data: { ticketId: ticket.id, authorType: "tenant", authorName: session.name, body: text },
  });

  return NextResponse.json(
    {
      ok: true,
      id: ticket.id,
      message: `Ticket raised for ${property?.name ?? "your business"} — our team typically responds within a few hours.`,
    },
    { status: 201 }
  );
}
