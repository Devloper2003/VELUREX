import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { signToken, signMfaToken, setSessionCookie, Role } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { logPlatformAction } from "@/lib/platform";
import { limitLoginIp, isLockedOut, recordLoginFailure, clearLoginFailures } from "@/lib/rate-limit";

/**
 * POST /api/auth/login
 *
 * Security layers:
 * 1. Per-IP request budget (20 / 5 min)          → 429 with Retry-After
 * 2. Per-email lockout (5 failures → 15 min lock) → 429
 * 3. scrypt password verification (timing-safe)
 * 4. TOTP 2FA: enabled accounts get a 5-minute purpose:"mfa" token instead of
 *    a session — the real session is only issued by /api/auth/2fa/challenge.
 * 5. On full success the session JWT is set as an HttpOnly cookie (plus the
 *    body token for in-memory SPA use — never persisted to localStorage).
 */
export async function POST(req: NextRequest) {
  try {
    // ── 0. Rate limiting (before any DB touch)
    const ipResult = limitLoginIp(req);
    if (!ipResult.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts from this network. Please wait and try again." },
        { status: 429, headers: { "Retry-After": String(ipResult.retryAfterSec ?? 60) } }
      );
    }

    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    const normEmail = String(email).toLowerCase().trim();

    const lock = isLockedOut(normEmail);
    if (!lock.allowed) {
      return NextResponse.json(
        {
          error: `Too many failed attempts for this account. It is locked for ${Math.ceil((lock.retryAfterSec ?? 900) / 60)} more minute(s).`,
        },
        { status: 429, headers: { "Retry-After": String(lock.retryAfterSec ?? 900) } }
      );
    }

    // ── 1. Platform (software owner) accounts — checked first
    const platformUser = await db.platformUser.findUnique({ where: { email: normEmail } });
    if (platformUser) {
      if (!platformUser.active || !verifyPassword(password, platformUser.passwordHash)) {
        recordLoginFailure(normEmail);
        return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
      }
      clearLoginFailures(normEmail);

      // 2FA challenge — no session until the TOTP code is verified.
      if (platformUser.totpEnabled && !platformUser.mustChangePassword) {
        const mfaToken = await signMfaToken(platformUser.id);
        return NextResponse.json({
          twoFactorRequired: true,
          mfaToken,
          user: {
            id: platformUser.id,
            name: platformUser.name,
            email: platformUser.email,
            role: platformUser.role,
            propertyId: "",
            propertyName: "Velurex Platform",
          },
        });
      }

      const token = await signToken({
        sub: platformUser.id,
        role: platformUser.role as Role,
        name: platformUser.name,
        email: platformUser.email,
        propertyId: "",
        isDemo: platformUser.isDemo,
        mustChangePassword: platformUser.mustChangePassword,
      });
      await db.platformUser.update({
        where: { id: platformUser.id },
        data: { lastLoginAt: new Date() },
      });
      if (!platformUser.mustChangePassword) {
        await logPlatformAction({
          actorId: platformUser.id,
          actorName: platformUser.email,
          action: "OWNER_LOGIN",
          entity: "platform_user",
          entityId: platformUser.id,
          details: `${platformUser.name} signed in to the platform dashboard`,
        });
      }
      const res = NextResponse.json({
        token,
        mustChangePassword: platformUser.mustChangePassword,
        user: {
          id: platformUser.id,
          name: platformUser.name,
          email: platformUser.email,
          role: platformUser.role,
          propertyId: "",
          propertyName: "Velurex Platform",
        },
      });
      if (!platformUser.mustChangePassword) setSessionCookie(res, token, req);
      return res;
    }

    // ── 2. Hotel staff accounts (existing flow, extended with subscription checks)
    const staff = await db.staff.findUnique({
      where: { email: normEmail },
      include: { property: true },
    });

    if (!staff || !staff.active || !verifyPassword(password, staff.passwordHash)) {
      recordLoginFailure(normEmail);
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    clearLoginFailures(normEmail);

    // Suspended tenants are blocked at the front door (data is retained, never deleted).
    if (staff.property.subscriptionStatus === "suspended" || staff.property.deletedAt) {
      return NextResponse.json(
        {
          error:
            "Your workspace is currently suspended. Your data is safe — pay your outstanding invoice or contact support to restore access.",
          code: "ACCOUNT_SUSPENDED",
        },
        { status: 403 }
      );
    }

    // 2FA challenge for enabled hotel accounts (after the temp-password reset).
    if (staff.totpEnabled && !staff.mustChangePassword) {
      const mfaToken = await signMfaToken(staff.id);
      return NextResponse.json({
        twoFactorRequired: true,
        mfaToken,
        user: {
          id: staff.id,
          name: staff.name,
          email: staff.email,
          role: staff.role,
          propertyId: staff.propertyId,
          propertyName: staff.property.name,
        },
      });
    }

    const token = await signToken({
      sub: staff.id,
      role: staff.role as Role,
      name: staff.name,
      email: staff.email,
      propertyId: staff.propertyId,
      mustChangePassword: staff.mustChangePassword,
    });

    await db.staff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
    if (!staff.mustChangePassword) {
      await logActivity({
        propertyId: staff.propertyId,
        staffId: staff.id,
        staffName: staff.name,
        action: "LOGIN",
        entity: "staff",
        entityId: staff.id,
        details: `${staff.name} (${staff.role}) signed in`,
      });
    }

    const res = NextResponse.json({
      token,
      mustChangePassword: staff.mustChangePassword,
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        propertyId: staff.propertyId,
        propertyName: staff.property.name,
      },
    });
    if (!staff.mustChangePassword) setSessionCookie(res, token, req);
    return res;
  } catch (e) {
    console.error("login error", e);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
