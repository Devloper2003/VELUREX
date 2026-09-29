import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyMfaToken, signToken, setSessionCookie, Role } from "@/lib/auth";
import { decryptJSON } from "@/lib/crypto";
import { verifyTotp } from "@/lib/totp";
import { verifyPassword } from "@/lib/password";
import { logActivity } from "@/lib/business";
import { logPlatformAction } from "@/lib/platform";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/2fa/challenge
 * Second factor of the login flow: { mfaToken, code } or
 * { mfaToken, recoveryCode }. Verifies the TOTP seed (±1 window) or a
 * single-use recovery code, then issues the REAL session (HttpOnly cookie +
 * body token). Rate limited per mfa token so codes can't be brute-forced.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const mfaToken = String((body as Record<string, unknown> | null)?.mfaToken ?? "");
    const code = String((body as Record<string, unknown> | null)?.code ?? "").trim();
    const recoveryCode = String((body as Record<string, unknown> | null)?.recoveryCode ?? "").trim();

    const sub = mfaToken ? await verifyMfaToken(mfaToken) : null;
    if (!sub) {
      return NextResponse.json({ error: "This verification request expired — please sign in again." }, { status: 401 });
    }

    const rl = rateLimit(`2fa-challenge:${sub}`, 8, 10 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many incorrect codes. Start again from the sign-in screen." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 300) } }
      );
    }

    // The mfa subject may be a platform user or a staff member.
    const platformUser = await db.platformUser.findUnique({ where: { id: sub } });
    const staff = platformUser ? null : await db.staff.findUnique({ where: { id: sub }, include: { property: true } });
    const account = platformUser ?? staff;
    if (!account || !account.active || !account.totpEnabled) {
      return NextResponse.json({ error: "Two-factor authentication is not active for this account." }, { status: 400 });
    }

    let usedRecovery = false;
    let recoveryWarning: string | undefined;

    if (recoveryCode) {
      // Single-use recovery code: verify against stored scrypt hashes, burn it.
      const hashes: string[] = JSON.parse(account.totpRecoveryCodes ?? "[]");
      let matchIdx = -1;
      for (let i = 0; i < hashes.length; i++) {
        if (verifyPassword(recoveryCode.replace(/\s+/g, "").toUpperCase(), hashes[i])) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx === -1) {
        return NextResponse.json({ error: "Invalid recovery code." }, { status: 401 });
      }
      hashes.splice(matchIdx, 1);
      const remaining = hashes.length;
      if (platformUser) {
        await db.platformUser.update({ where: { id: sub }, data: { totpRecoveryCodes: JSON.stringify(hashes) } });
      } else if (staff) {
        await db.staff.update({ where: { id: sub }, data: { totpRecoveryCodes: JSON.stringify(hashes) } });
      }
      usedRecovery = true;
      if (remaining <= 2) {
        recoveryWarning = `Only ${remaining} recovery code(s) left — regenerate soon.`;
      }
    } else {
      const seed = decryptJSON<{ seed?: string }>(account.totpSecret ?? "").seed ?? "";
      if (!seed || !code || !verifyTotp(seed, code)) {
        return NextResponse.json({ error: "That code didn't match. Check your app and try again." }, { status: 401 });
      }
    }

    // Full session — same shape as a normal login response.
    if (platformUser) {
      const token = await signToken({
        sub: platformUser.id,
        role: platformUser.role as Role,
        name: platformUser.name,
        email: platformUser.email,
        propertyId: "",
        isDemo: platformUser.isDemo,
        mustChangePassword: false,
      });
      await db.platformUser.update({ where: { id: platformUser.id }, data: { lastLoginAt: new Date() } });
      await logPlatformAction({
        actorId: platformUser.id,
        actorName: platformUser.email,
        action: "OWNER_LOGIN",
        entity: "platform_user",
        entityId: platformUser.id,
        details: `${platformUser.name} signed in with two-factor authentication${usedRecovery ? " (recovery code used)" : ""}`,
      });
      const res = NextResponse.json({
        token,
        mustChangePassword: false,
        ...(typeof recoveryWarning !== "undefined" ? { warning: recoveryWarning } : {}),
        user: {
          id: platformUser.id,
          name: platformUser.name,
          email: platformUser.email,
          role: platformUser.role,
          propertyId: "",
          propertyName: "Velurex Platform",
        },
      });
      setSessionCookie(res, token, req);
      return res;
    }

    if (!staff) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    if (staff.property.subscriptionStatus === "suspended" || staff.property.deletedAt) {
      return NextResponse.json(
        { error: "Your workspace is currently suspended. Contact support to restore access.", code: "ACCOUNT_SUSPENDED" },
        { status: 403 }
      );
    }

    const token = await signToken({
      sub: staff.id,
      role: staff.role as Role,
      name: staff.name,
      email: staff.email,
      propertyId: staff.propertyId,
      mustChangePassword: false,
    });
    await db.staff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
    await logActivity({
      propertyId: staff.propertyId,
      staffId: staff.id,
      staffName: staff.name,
      action: "LOGIN",
      entity: "staff",
      entityId: staff.id,
      details: `${staff.name} (${staff.role}) signed in with two-factor authentication${usedRecovery ? " (recovery code used)" : ""}`,
    });
    const res = NextResponse.json({
      token,
      mustChangePassword: false,
      ...(typeof recoveryWarning !== "undefined" ? { warning: recoveryWarning } : {}),
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        propertyId: staff.propertyId,
        propertyName: staff.property.name,
      },
    });
    setSessionCookie(res, token, req);
    return res;
  } catch (e) {
    console.error("2fa challenge error", e);
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
