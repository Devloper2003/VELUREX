import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET  /api/announcements/active — in-app banner announcements visible to this tenant.
 * POST /api/announcements/active — mark read/dismiss: { announcementId }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  if (!propertyId) return NextResponse.json({ announcements: [] });

  const [property, reads] = await Promise.all([
    db.property.findUnique({
      where: { id: propertyId },
      include: { subscription: { include: { plan: true } } },
    }),
    db.announcementRead.findMany({ where: { propertyId }, select: { announcementId: true } }),
  ]);
  const readIds = new Set(reads.map((r) => r.announcementId));

  const announcements = await db.announcement.findMany({
    where: { active: true, channel: "in_app", isDemo: false },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const visible = announcements
    .filter((a) => {
      if (readIds.has(a.id)) return false;
      if (a.audience === "all") return true;
      if (a.audience === "plan") return a.planCode === property?.subscription?.plan.code;
      if (a.audience === "tenants") {
        try { return (JSON.parse(a.propertyIds) as string[]).includes(propertyId); } catch { return false; }
      }
      return false;
    })
    .map((a) => ({ id: a.id, title: a.title, body: a.body, createdAt: a.createdAt }));

  return NextResponse.json({ announcements: visible });
}

/** POST — dismiss (record read) so the banner stops showing for this tenant. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  if (!propertyId) return NextResponse.json({ error: "No tenant context" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const announcementId = String(body.announcementId ?? "");
  if (!announcementId) return NextResponse.json({ error: "announcementId required" }, { status: 400 });

  await db.announcementRead.upsert({
    where: { announcementId_propertyId: { announcementId, propertyId } },
    create: { announcementId, propertyId },
    update: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
