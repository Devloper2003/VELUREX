import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { hashPassword } from "@/lib/password";

const ROLES = ["hotel_admin", "front_desk", "housekeeping", "restaurant_staff"];

/** PATCH /api/settings/staff/[id] — [hotel_admin] partial staff update. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: adminName } = auth.session;

  const { id } = await ctx.params;

  const staff = await db.staff.findFirst({ where: { id, propertyId } });
  if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: { name?: string; phone?: string; role?: string; active?: boolean; passwordHash?: string; googleEmail?: string | null } = {};
  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    data.name = name;
    if (name !== staff.name) changed.push("name");
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone).trim();
    data.phone = phone;
    if (phone !== staff.phone) changed.push("phone");
  }
  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (!ROLES.includes(role)) {
      return NextResponse.json({ error: `Role must be one of: ${ROLES.join(", ")}` }, { status: 400 });
    }
    data.role = role;
    if (role !== staff.role) changed.push(`role → ${role}`);
  }
  if (body.active !== undefined) {
    const active = Boolean(body.active);
    if (!active && staff.id === sub) {
      return NextResponse.json({ error: "You cannot deactivate your own account" }, { status: 400 });
    }
    data.active = active;
    if (active !== staff.active) changed.push(active ? "activated" : "deactivated");
  }
  if (body.googleEmail !== undefined) {
    const ge = String(body.googleEmail).trim().toLowerCase() || null;
    if (ge && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ge)) {
      return NextResponse.json({ error: "Google account must be a valid email" }, { status: 400 });
    }
    data.googleEmail = ge;
    if (ge !== staff.googleEmail) changed.push(ge ? `google account linked (${ge})` : "google account unlinked");
  }
  if (body.password !== undefined) {
    const password = String(body.password);
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }
    data.passwordHash = hashPassword(password);
    changed.push("password reset");
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const updated = await db.staff.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName,
    action: "STAFF_UPDATE",
    entity: "Staff",
    entityId: id,
    details: `${updated.name}: ${changed.join(", ") || "no changes"}`,
  });

  return NextResponse.json({
    staff: {
      id: updated.id, name: updated.name, email: updated.email, role: updated.role,
      active: updated.active, phone: updated.phone, googleEmail: updated.googleEmail, createdAt: updated.createdAt,
    },
  });
}
