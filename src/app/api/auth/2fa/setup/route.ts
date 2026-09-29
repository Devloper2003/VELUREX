import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, isPlatformRole } from "@/lib/auth";
import { encryptJSON } from "@/lib/crypto";
import { generateTotpSecret, otpauthUri } from "@/lib/totp";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/2fa/setup
 * Step 1 of enrollment: generate a TOTP seed, store it AES-256-GCM ENCRYPTED
 * in totpSecret (totpEnabled stays false until the code is confirmed via
 * /api/auth/2fa/enable). Returns the Base32 secret + otpauth:// provisioning
 * URI exactly once — the plaintext seed is never again returned by any API.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { sub, role, email, mustChangePassword } = auth.session;

  const rl = rateLimit(`2fa-setup:${sub}`, 5, 10 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }
  if (mustChangePassword) {
    return NextResponse.json(
      { error: "Set your permanent password before enabling two-factor authentication." },
      { status: 403 }
    );
  }

  const secret = generateTotpSecret();
  const encrypted = encryptJSON({ seed: secret });
  const uri = otpauthUri(secret, email);

  if (isPlatformRole(role)) {
    await db.platformUser.update({ where: { id: sub }, data: { totpSecret: encrypted, totpEnabled: false } });
  } else {
    await db.staff.update({ where: { id: sub }, data: { totpSecret: encrypted, totpEnabled: false } });
  }

  return NextResponse.json({ secret, otpauthUri: uri });
}
