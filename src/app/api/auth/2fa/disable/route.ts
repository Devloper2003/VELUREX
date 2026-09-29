import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, isPlatformRole } from "@/lib/auth";
import { decryptJSON } from "@/lib/crypto";
import { verifyTotp } from "@/lib/totp";
import { verifyPassword } from "@/lib/password";
import { logActivity } from "@/lib/business";
import { logPlatformAction } from "@/lib/platform";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/2fa/disable
 * Requires BOTH the account password and a live TOTP code (a stolen phone
 * alone, or a leaked password alone, must not be able to turn 2FA off).
 * Clears the encrypted seed + recovery codes and audits the event.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { sub, role, propertyId } = auth.session;

  const rl = rateLimit(`2fa-disable:${sub}`, 5, 10 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const password = String((body as Record<string, unknown> | null)?.password ?? "");
  const code = String((body as Record<string, unknown> | null)?.code ?? "");
  if (!password || !code) {
    return NextResponse.json({ error: "Account password and a current code are both required" }, { status: 400 });
  }

  const isPlatform = isPlatformRole(role);
  const account = isPlatform
    ? await db.platformUser.findUnique({ where: { id: sub } })
    : await db.staff.findUnique({ where: { id: sub } });

  if (!account || !account.active) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!account.totpEnabled) return NextResponse.json({ error: "Two-factor authentication is not enabled" }, { status: 400 });

  if (!verifyPassword(password, account.passwordHash)) {
    return NextResponse.json({ error: "Account password is incorrect" }, { status: 400 });
  }
  const seed = decryptJSON<{ seed?: string }>(account.totpSecret ?? "").seed ?? "";
  if (!seed || !verifyTotp(seed, code)) {
    return NextResponse.json({ error: "That code didn't match. Check your app and try again." }, { status: 400 });
  }

  if (isPlatform) {
    await db.platformUser.update({
      where: { id: sub },
      data: { totpSecret: null, totpEnabled: false, totpRecoveryCodes: null },
    });
    await logPlatformAction({
      actorId: account.id,
      actorName: account.email,
      action: "AUTH_2FA_DISABLED",
      entity: "platform_user",
      entityId: account.id,
      details: `${account.name} disabled two-factor authentication`,
    });
  } else {
    await db.staff.update({
      where: { id: sub },
      data: { totpSecret: null, totpEnabled: false, totpRecoveryCodes: null },
    });
    await logActivity({
      propertyId: propertyId ?? "",
      staffId: account.id,
      staffName: account.name,
      action: "AUTH_2FA_DISABLED",
      entity: "staff",
      entityId: account.id,
      details: `${account.name} disabled two-factor authentication`,
    });
  }

  return NextResponse.json({ ok: true, totpEnabled: false });
}
