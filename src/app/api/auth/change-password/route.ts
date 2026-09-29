import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, signToken, setSessionCookie, Role, isPlatformRole } from "@/lib/auth";
import { hashPassword, verifyPassword, validatePermanentPassword } from "@/lib/password";
import { logActivity } from "@/lib/business";
import { logPlatformAction } from "@/lib/platform";
import { rateLimit, clientIp } from "@/lib/rate-limit";

/**
 * POST /api/auth/change-password
 *
 * Mandatory first-login flow: any account created with a temporary password
 * (format `Vlx@XXXXXXXX`, mustChangePassword=true) must call this endpoint to
 * set a PERMANENT password before the app can be used.
 *
 * Body: { currentPassword, newPassword }
 * - currentPassword is verified against the stored scrypt hash (this is the
 *   temp password on first login, or the existing password on later changes).
 * - newPassword must satisfy the permanent-password policy (8+ chars, letter,
 *   digit, symbol). It is stored ONLY as a scrypt hash — plain text never
 *   touches the database.
 * - On success mustChangePassword flips to false and a fresh token is issued
 *   so the UI drops the reset gate everywhere.
 */
export async function POST(req: NextRequest) {
  // Brute-force wall: the current-password check below is guessable, so cap
  // guesses at 5 per minute per IP (scrypt is deliberately slow, this stops loops).
  const rl = rateLimit(`pwchange:ip:${clientIp(req)}`, 5, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { sub, role, propertyId } = auth.session;

  const body = await req.json().catch(() => null);
  const currentPassword = String((body as Record<string, unknown> | null)?.currentPassword ?? "");
  const newPassword = String((body as Record<string, unknown> | null)?.newPassword ?? "");
  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "Current and new password are both required" },
      { status: 400 }
    );
  }

  const policyError = validatePermanentPassword(newPassword);
  if (policyError) return NextResponse.json({ error: policyError }, { status: 400 });

  const isPlatform = isPlatformRole(role);
  const account = isPlatform
    ? await db.platformUser.findUnique({ where: { id: sub } })
    : await db.staff.findUnique({ where: { id: sub } });

  if (!account || !account.active) {
    return NextResponse.json({ error: "Account not found or inactive" }, { status: 404 });
  }
  if (!verifyPassword(currentPassword, account.passwordHash)) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
  }

  const wasTemporary = account.mustChangePassword;
  const passwordHash = hashPassword(newPassword);
  if (isPlatform) {
    await db.platformUser.update({
      where: { id: sub },
      data: { passwordHash, mustChangePassword: false },
    });
  } else {
    await db.staff.update({
      where: { id: sub },
      data: { passwordHash, mustChangePassword: false },
    });
  }

  const token = await signToken({
    sub: account.id,
    role: account.role as Role,
    name: account.name,
    email: account.email,
    propertyId: isPlatform ? "" : propertyId,
    ...(isPlatform && "isDemo" in account ? { isDemo: (account as { isDemo: boolean }).isDemo } : {}),
    mustChangePassword: false,
  });

  if (isPlatform) {
    await logPlatformAction({
      actorId: account.id,
      actorName: account.email,
      action: "PASSWORD_CHANGED",
      entity: "platform_user",
      entityId: account.id,
      details: `${account.name} set a permanent password${wasTemporary ? " (temporary password replaced)" : ""}`,
    });
  } else {
    await logActivity({
      propertyId,
      staffId: account.id,
      staffName: account.name,
      action: "PASSWORD_CHANGED",
      entity: "staff",
      entityId: account.id,
      details: `Permanent password set${wasTemporary ? " (temporary password replaced)" : ""}`,
    });
  }

  const res = NextResponse.json({ ok: true, token, mustChangePassword: false });
  // Persist the fresh session in an HttpOnly cookie as well.
  setSessionCookie(res, token, req);
  return res;
}
