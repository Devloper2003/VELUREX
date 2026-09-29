import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/owner/announcements/[id] — activate/deactivate. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const announcement = await db.announcement.findUnique({ where: { id } });
  if (!announcement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const active = !announcement.active;
  await db.announcement.update({ where: { id }, data: { active } });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ANNOUNCEMENT_UPDATED",
    entity: "announcement", entityId: id,
    details: `"${announcement.title}" ${active ? "re-activated" : "deactivated"}`,
  });
  return NextResponse.json({ ok: true, active });
}

/** DELETE /api/owner/announcements/[id]. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const announcement = await db.announcement.findUnique({ where: { id } });
  if (!announcement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.announcement.delete({ where: { id } });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "ANNOUNCEMENT_DELETED",
    entity: "announcement", entityId: id, details: `"${announcement.title}" deleted`,
  });
  return NextResponse.json({ ok: true });
}
