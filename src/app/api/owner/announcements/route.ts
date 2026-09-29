import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";
import { demoScope, notDemoPlatform, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";

/** GET /api/owner/announcements — all announcements with read stats. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const [announcements, businessCount] = await Promise.all([
    db.announcement.findMany({
      where: notDemoPlatform(scope),
      orderBy: { createdAt: "desc" },
      include: { reads: { where: notDemoTenant(scope), include: { property: { select: { name: true } } } } },
    }),
    db.property.count({ where: { deletedAt: null, ...notDemoTenantId(scope) } }),
  ]);

  return NextResponse.json({
    announcements: announcements.map((a) => ({
      id: a.id, title: a.title, body: a.body, audience: a.audience, planCode: a.planCode,
      propertyIds: a.propertyIds, channel: a.channel, active: a.active, createdBy: a.createdBy,
      createdAt: a.createdAt,
      readBy: a.reads.map((r) => r.property?.name ?? "—"),
      readCount: a.reads.length,
    })),
    businessCount,
  });
}

/** POST /api/owner/announcements — broadcast to all / by plan / by tenant list. */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const scope = await demoScope(auth.session, req);

  const title = String(body.title ?? "").trim();
  const text = String(body.body ?? "").trim();
  const audience = ["all", "plan", "tenants"].includes(String(body.audience)) ? String(body.audience) : "all";
  const channel = ["in_app", "email", "whatsapp"].includes(String(body.channel)) ? String(body.channel) : "in_app";
  const planCode = String(body.planCode ?? "");
  const propertyIds = Array.isArray(body.propertyIds) ? body.propertyIds.map(String) : [];

  if (!title || !text) return NextResponse.json({ error: "Title and body are required" }, { status: 400 });
  if (audience === "plan" && !planCode)
    return NextResponse.json({ error: "planCode is required for plan-targeted announcements" }, { status: 400 });
  if (audience === "tenants" && propertyIds.length === 0)
    return NextResponse.json({ error: "Select at least one business" }, { status: 400 });

  const announcement = await db.announcement.create({
    data: {
      title, body: text, audience, planCode, propertyIds: JSON.stringify(propertyIds),
      channel, createdBy: owner.email,
    },
  });

  // Count recipients
  let recipients: number;
  if (audience === "plan") {
    recipients = await db.subscription.count({
      where: { status: { in: ["active", "trial", "overdue"] }, plan: { code: planCode }, ...notDemoTenant(scope) },
    });
  } else if (audience === "tenants") {
    recipients = propertyIds.length;
  } else {
    recipients = await db.property.count({ where: { deletedAt: null, ...notDemoTenantId(scope) } });
  }

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ANNOUNCEMENT_SENT",
    entity: "announcement", entityId: announcement.id,
    details: `"${title}" → ${audience === "all" ? "all tenants" : audience === "plan" ? `${planCode} plan` : `${propertyIds.length} tenants`} (${recipients} recipients, ${channel})`,
  });

  return NextResponse.json({ ok: true, id: announcement.id, recipients }, { status: 201 });
}
