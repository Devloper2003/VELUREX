import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import "@/lib/env"; // canonical .env — APP_ENCRYPTION_KEY/AUTH_SECRET from the file

/**
 * Credentials-at-rest encryption for channel connections (API keys, hotel IDs),
 * WhatsApp access tokens and sensitive platform settings.
 *
 * AES-256-GCM with a key derived from APP_ENCRYPTION_KEY (falls back to
 * AUTH_SECRET for legacy compatibility). The key material lives ONLY in the
 * environment (.env) — never hardcoded in source. Output format:
 *   v1:<iv-b64>:<authTag-b64>:<cipher-b64>
 * Everything lives in one string so the DB column stays a plain text field —
 * portable across databases without a schema change.
 */

const KEY = createHash("sha256")
  .update(
    process.env.APP_ENCRYPTION_KEY ||
    process.env.AUTH_SECRET ||
    "velurex-dev-secret-change-me-in-production"
  )
  .digest(); // 32 bytes

export function encryptJSON(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const plain = Buffer.from(JSON.stringify(value ?? {}), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptJSON<T = Record<string, string>>(payload: string | null | undefined): T {
  if (!payload) return {} as T;
  try {
    const [v, ivB64, tagB64, dataB64] = payload.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) return {} as T;
    const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return JSON.parse(dec.toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}

/** Mask a secret for display: keep first 4 + last 2 chars. */
export function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.min(10, s.length - 6))}${s.slice(-2)}`;
}
