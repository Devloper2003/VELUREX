import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, signToken } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";

/**
 * POST /api/owner/impersonate — start (owner) or exit (either side).
 *
 * start: owner sends { action: "start", propertyId } → picks the business's
 *        primary hotel_admin, audits IMPERSONATE_START, returns a tenant JWT.
 * exit:  the impersonating owner sends { action: "exit", propertyId } →
 *        audits IMPERSONATE_END and returns nothing (client restores the
 *        owner session it kept aside).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const session = auth.session;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "start") {
    if (session.role !== "software_owner") {
      return NextResponse.json({ error: "Only the software owner can impersonate" }, { status: 403 });
    }
    const propertyId = String(body.propertyId ?? "");
    const property = await db.property.findUnique({ where: { id: propertyId } });
    if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

    const admin = await db.staff.findFirst({
      where: { propertyId, role: "hotel_admin", active: true },
      orderBy: { createdAt: "asc" },
    });
    if (!admin) {
      return NextResponse.json({ error: "This business has no active admin account to impersonate" }, { status: 404 });
    }

    const token = await signToken({
      sub: admin.id,
      role: "hotel_admin",
      name: admin.name,
      email: admin.email,
      propertyId,
      impersonatedBy: session.email,
    });

    await logPlatformAction({
      actorId: session.sub, actorName: session.email, action: "IMPERSONATE_START",
      entity: "property", entityId: propertyId, propertyId,
      details: `Login as ${admin.name} <${admin.email}> @ ${property.name}`,
    });

    return NextResponse.json({
      token,
      user: {
        id: admin.id, name: admin.name, email: admin.email, role: "hotel_admin",
        propertyId, propertyName: property.name,
      },
    });
  }

  if (action === "exit") {
    const propertyId = String(body.propertyId ?? "");
    const property = propertyId ? await db.property.findUnique({ where: { id: propertyId } }) : null;
    await logPlatformAction({
      actorId: session.sub, actorName: session.email, action: "IMPERSONATE_END",
      entity: "property", entityId: propertyId, propertyId,
      details: `Impersonation session ended${property ? ` for ${property.name}` : ""}`,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be start or exit" }, { status: 400 });
}
