import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { logPlatformAction } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/owner/users/[id] — user profile + recent login history.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const user = await db.staff.findUnique({
    where: { id },
    include: { property: { select: { id: true, name: true, city: true, subscriptionStatus: true } } },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const logins = await db.activityLog.findMany({
    where: { staffId: id, action: "LOGIN" },
    orderBy: { createdAt: "desc" },
    take: 15,
  });

  return NextResponse.json({
    user: {
      id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role,
      active: user.active, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
      googleEmail: user.googleEmail,
      property: user.property,
    },
    loginHistory: logins.map((l) => ({ at: l.createdAt, details: l.details })),
  });
}

/**
 * PATCH /api/owner/users/[id] — actions: reset_password | force_logout |
 * activate | deactivate
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const user = await db.staff.findUnique({ where: { id }, include: { property: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  switch (action) {
    case "reset_password": {
      // Consistent temp-password format (`Vlx@XXXXXXXX`) — the user MUST set a
      // permanent password on next login (mustChangePassword=true).
      const temp = generateTempPassword();
      await db.staff.update({
        where: { id },
        data: { passwordHash: hashPassword(temp), mustChangePassword: true },
      });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: "USER_PASSWORD_RESET",
        entity: "staff", entityId: id, propertyId: user.propertyId,
        details: `Password reset for ${user.name} <${user.email}> — temp password issued`,
      });
      // The temp password is returned once (owner copies it into the credential email/WhatsApp).
      return NextResponse.json({ ok: true, tempPassword: temp });
    }

    case "force_logout": {
      // Any token issued BEFORE now is stale: /api/auth/me rejects tokens whose
      // iat predates lastLoginAt, so the user's open tabs are signed out on their
      // next poll; fresh logins are unaffected.
      await db.staff.update({ where: { id }, data: { lastLoginAt: new Date(Date.now() + 5000) } });
      await db.activityLog.create({
        data: {
          propertyId: user.propertyId, staffId: user.id, staffName: user.name,
          action: "FORCE_LOGOUT", entity: "staff", entityId: user.id,
          details: `Sessions force-terminated by platform owner (${owner.email})`,
        },
      });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: "USER_FORCE_LOGOUT",
        entity: "staff", entityId: id, propertyId: user.propertyId,
        details: `Force logout for ${user.name} <${user.email}> — active tabs signed out on next poll`,
      });
      return NextResponse.json({ ok: true });
    }

    case "activate":
    case "deactivate": {
      const active = action === "activate";
      if (!active && user.role === "hotel_admin") {
        const activeAdmins = await db.staff.count({
          where: { propertyId: user.propertyId, role: "hotel_admin", active: true, id: { not: id } },
        });
        if (activeAdmins === 0) {
          return NextResponse.json(
            { error: "Cannot deactivate the only active admin of a business" },
            { status: 400 }
          );
        }
      }
      await db.staff.update({ where: { id }, data: { active } });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
        entity: "staff", entityId: id, propertyId: user.propertyId,
        details: `${user.name} <${user.email}> ${active ? "activated" : "deactivated"}`,
      });
      return NextResponse.json({ ok: true, active });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
