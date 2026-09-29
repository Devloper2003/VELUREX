import crypto from "crypto";

/**
 * Password hashing with Node's built-in scrypt (no native deps).
 * Format: scrypt$<saltHex>$<hashHex>
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/**
 * Temporary password generator — one consistent format for EVERY new user:
 *
 *     Vlx@XXXXXXXX
 *
 *   - `Vlx@` fixed brand prefix (identifies it as a Velurex-issued temp password)
 *   - 8 random chars from an unambiguous alphabet (no 0/O, 1/l/I)
 *
 * Users created with a temp password MUST set a permanent password on first
 * login (mustChangePassword=true) before they can use the app. Only the
 * scrypt hash is ever stored — the temp password itself is returned once to
 * the creating admin and never persisted in plain text.
 */
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generateTempPassword(): string {
  const bytes = crypto.randomBytes(8);
  let body = "";
  for (let i = 0; i < 8; i++) body += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  return `Vlx@${body}`;
}

/** Looks like one of our temp passwords (Vlx@ + 8 chars)? */
export function looksLikeTempPassword(pw: string): boolean {
  return /^Vlx@[A-Za-z0-9]{8}$/.test(pw);
}

/**
 * Permanent password policy: min 8 chars with at least one letter, one digit
 * and one symbol. Returns an error message, or null when acceptable.
 */
export function validatePermanentPassword(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Za-z]/.test(pw)) return "Password must contain at least one letter";
  if (!/[0-9]/.test(pw)) return "Password must contain at least one digit";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must contain at least one symbol";
  return null;
}

/**
 * Cryptographically-random human-friendly token (unambiguous alphabet),
 * returned grouped as XXXXX-XXXXX. Used for 2FA recovery codes.
 */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomToken(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out.slice(0, 5) + "-" + out.slice(5);
}
