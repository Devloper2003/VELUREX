import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, isPlatformRole } from "@/lib/auth";
import { decryptJSON } from "@/lib/crypto";
import { verifyTotp } from "@/lib/totp";
import { hashPassword, randomToken } from "@/lib/password";
import { logActivity } from "@/lib/business";
import { logPlatformAction } from "@/lib/platform";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/2fa/enable
 * Step 2 of enrollment: confirm a live code from the authenticator app.
 * On success: totpEnabled = true, and 8 single-use recovery codes are
 * generated (scrypt-hashed at rest, returned in plaintext exactly once).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { sub, role, propertyId, name } = auth.session;

  const rl = rateLimit(`2fa-enable:${sub}`, 5, 10 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const code = String((body as Record<string, unknown> | null)?.code ?? "");
  if (!code) return NextResponse.json({ error: "Enter the 6-digit code from your app" }, { status: 400 });

  const isPlatform = isPlatformRole(role);
  const account = isPlatform
    ? await db.platformUser.findUnique({ where: { id: sub } })
    : await db.staff.findUnique({ where: { id: sub } });

  if (!account || !account.active) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!account.totpSecret) {
    return NextResponse.json({ error: "Start the setup first — no pending authenticator seed." }, { status: 400 });
  }

  const seed = decryptJSON<{ seed?: string }>(account.totpSecret).seed ?? "";
  if (!seed || !verifyTotp(seed, code)) {
    return NextResponse.json({ error: "That code didn't match. Check your app and try again." }, { status: 400 });
  }

  // 8 single-use recovery codes, scrypt-hashed at rest.
  const recoveryCodes = Array.from({ length: 8 }, () => randomToken(10));
  const recoveryHashes = recoveryCodes.map((c) => hashPassword(c));

  if (isPlatform) {
    await db.platformUser.update({
      where: { id: sub },
      data: { totpEnabled: true, totpRecoveryCodes: JSON.stringify(recoveryHashes) },
    });
    await logPlatformAction({
      actorId: account.id,
      actorName: account.email,
      action: "AUTH_2FA_ENABLED",
      entity: "platform_user",
      entityId: account.id,
      details: `${account.name} enabled two-factor authentication`,
    });
  } else {
    await db.staff.update({
      where: { id: sub },
      data: { totpEnabled: true, totpRecoveryCodes: JSON.stringify(recoveryHashes) },
    });
    await logActivity({
      propertyId: propertyId ?? "",
      staffId: account.id,
      staffName: account.name,
      action: "AUTH_2FA_ENABLED",
      entity: "staff",
      entityId: account.id,
      details: `${account.name} enabled two-factor authentication`,
    });
  }

  return NextResponse.json({
    ok: true,
    totpEnabled: true,
    recoveryCodes, // shown ONCE — only hashes are stored
    message: "Two-factor authentication is on. Save these recovery codes somewhere safe.",
    actorName: name,
  });
}
