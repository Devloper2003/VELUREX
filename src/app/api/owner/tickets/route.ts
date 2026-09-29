import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/tickets — support ticket queue.
 * Filters: status, priority, propertyId, search (subject/business).
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "";
  const priority = sp.get("priority") ?? "";
  const search = sp.get("search")?.trim() ?? "";

  const where: Record<string, unknown> = { ...notDemoTenant(scope) };
  if (status) where.status = status;
  else if (!status) where.status = { notIn: [] };
  if (priority) where.priority = priority;
  if (search) {
    where.OR = [
      { subject: { contains: search, mode: "insensitive" } },
      { property: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const tickets = await db.supportTicket.findMany({
    where,
    include: {
      property: { select: { id: true, name: true, city: true, subscriptionStatus: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  const now = Date.now();
  return NextResponse.json({
    tickets: tickets.map((t) => ({
      id: t.id,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      status: t.status,
      createdByName: t.createdByName,
      assignedTo: t.assignedTo,
      property: t.property,
      messageCount: t._count.messages,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body.slice(0, 120), authorType: t.messages[0].authorType, internal: t.messages[0].internal, at: t.messages[0].createdAt }
        : null,
      firstResponseAt: t.firstResponseAt,
      responseTimeMins: t.firstResponseAt
        ? Math.round((t.firstResponseAt.getTime() - t.createdAt.getTime()) / 60000)
        : null,
      ageHours: Math.round((now - t.createdAt.getTime()) / 3600000),
      resolvedAt: t.resolvedAt,
      createdAt: t.createdAt,
    })),
    total: tickets.length,
  });
}
