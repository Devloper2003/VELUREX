import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * RFC 6238 TOTP (time-based one-time password) — the standard behind Google
 * Authenticator / Authy / 1Password. Pure Node crypto, no third-party deps.
 *
 * - Secret: 20 random bytes, shared as Base32 (RFC 4648, no padding) so it
 *   can be typed into any authenticator app.
 * - Algorithm: HMAC-SHA1, 30-second step, 6 digits, ±1 step verification
 *   window (tolerates small clock drift).
 * - Comparison is constant-time (timingSafeEqual).
 *
 * The secret at rest is ALWAYS AES-256-GCM encrypted via lib/crypto.ts
 * (encryptJSON) — this module only ever sees the plaintext in memory for the
 * duration of a verification.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a fresh TOTP seed (20 bytes → 32-char Base32). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Compute the 6-digit TOTP for a secret at unix time `nowSec` (+ offset steps). */
export function totpCode(secretBase32: string, nowSec: number = Math.floor(Date.now() / 1000), stepOffset = 0): string {
  const counter = Math.floor(nowSec / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  // RFC 4226 dynamic truncation
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Constant-time string equality. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a user-supplied code against the current time window ±`window`
 * steps (default ±1 → accepts codes up to 30s "old" or "early").
 */
export function verifyTotp(secretBase32: string, code: string, window = 1): boolean {
  const normalized = (code || "").replace(/\D/g, "");
  if (normalized.length !== 6) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(totpCode(secretBase32, nowSec, i), normalized)) return true;
  }
  return false;
}

/** otpauth:// provisioning URI for authenticator apps (and QR codes). */
export function otpauthUri(secretBase32: string, email: string): string {
  const label = encodeURIComponent(`Velurex HMS:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: "Velurex HMS",
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
