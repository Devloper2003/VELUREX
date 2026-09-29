import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { signToken, isPlatformRole, setSessionCookie } from "@/lib/auth";

/**
 * GET /api/auth/me — session echo used by the shells. Handles both hotel staff
 * and platform (software_owner + Team & Roles members) sessions, and rejects
 * stale tokens after a force-logout (token iat must not predate lastLoginAt).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const session = auth.session;

  // ── Platform (software owner / team member) session
  if (isPlatformRole(session.role)) {
    const owner = await db.platformUser.findUnique({ where: { id: session.sub } });
    if (!owner || !owner.active) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // Force-logout check: tokens issued before the member's lastLoginAt are stale.
    if (
      !session.impersonatedBy &&
      owner.lastLoginAt &&
      session.iat &&
      session.iat * 1000 < owner.lastLoginAt.getTime() - 4000
    ) {
      return NextResponse.json(
        { error: "Session expired — please sign in again", code: "SESSION_STALE" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      user: {
        id: owner.id, name: owner.name, email: owner.email, role: owner.role,
        mustChangePassword: owner.mustChangePassword,
        totpEnabled: owner.totpEnabled,
        propertyId: "", propertyName: "Velurex Platform",
      },
      property: null,
    });
  }

  // ── Hotel staff session
  const staff = await db.staff.findUnique({
    where: { id: session.sub },
    include: { property: { select: { name: true, city: true, gstin: true, businessDate: true, currency: true, subscriptionStatus: true } } },
  });
  if (!staff) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Force-logout check: tokens issued before the staff member's lastLoginAt are stale.
  if (
    !session.impersonatedBy &&
    staff.lastLoginAt &&
    session.iat &&
    session.iat * 1000 < staff.lastLoginAt.getTime() - 4000
  ) {
    return NextResponse.json({ error: "Session expired — please sign in again", code: "SESSION_STALE" }, { status: 401 });
  }

  // Suspended tenants keep read-only visibility into their workspace.
  if (staff.property.subscriptionStatus === "suspended" && !session.impersonatedBy) {
    return NextResponse.json(
      { error: "Your workspace is suspended. Pay now or contact support to restore access.", code: "ACCOUNT_SUSPENDED" },
      { status: 403 }
    );
  }

  // Re-sign impersonation tokens so the header banner survives /me refreshes.
  if (session.impersonatedBy) {
    const token = await signToken({
      sub: staff.id,
      role: session.role,
      name: staff.name,
      email: staff.email,
      propertyId: staff.propertyId,
      impersonatedBy: session.impersonatedBy,
    });
    const res = NextResponse.json({
      token,
      user: {
        id: staff.id, name: staff.name, email: staff.email, role: staff.role,
        propertyId: staff.propertyId, propertyName: staff.property.name,
      },
      impersonating: session.impersonatedBy,
      property: staff.property,
    });
    setSessionCookie(res, token, req);
    return res;
  }

  return NextResponse.json({
    user: {
      id: staff.id, name: staff.name, email: staff.email, role: staff.role,
      totpEnabled: staff.totpEnabled,
      propertyId: staff.propertyId, propertyName: staff.property.name,
    },
    property: staff.property,
  });
}
