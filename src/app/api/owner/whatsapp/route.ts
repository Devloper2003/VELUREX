import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { decryptJSON, encryptJSON, maskSecret } from "@/lib/crypto";
import { logPlatformAction, setPlatformSetting } from "@/lib/platform";

/**
 * Platform-wide WhatsApp Cloud API (owner-level).
 *
 * Credentials live in PlatformSetting rows:
 *   whatsapp_display_phone   plain      display number, e.g. +91 98xxx
 *   whatsapp_phone_id        plain      Meta Phone Number ID (required to send)
 *   whatsapp_waba_id         plain      WhatsApp Business Account ID (optional)
 *   whatsapp_token           encrypted  AES-256-GCM {v: token} — NEVER returned in full
 *   whatsapp_status          plain      "connected" after a passing live test, else "error"
 *   whatsapp_last_checked_at plain      ISO timestamp of the last live test
 *
 * The stored encrypted shape mirrors getPlatformSetting(): the value column
 * holds encryptJSON({v}) and decryption reads {v}. Tenants without their own
 * config fall back to this platform config via src/lib/whatsapp.ts.
 */

const CORE_KEYS = ["whatsapp_display_phone", "whatsapp_phone_id", "whatsapp_waba_id", "whatsapp_token"];

interface PlatformWaState {
  configured: boolean;
  displayPhone: string;
  phoneNumberId: string;
  wabaId: string;
  tokenMasked: string;
  status: "connected" | "disconnected";
  lastCheckedAt: string | null;
  updatedAt: string | null;
}

async function loadPlatformWhatsappState(): Promise<PlatformWaState> {
  const rows = await db.platformSetting.findMany({
    where: { key: { in: [...CORE_KEYS, "whatsapp_status", "whatsapp_last_checked_at"] } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const tokenRow = byKey.get("whatsapp_token");
  let token = "";
  if (tokenRow) {
    token = tokenRow.encrypted
      ? decryptJSON<{ v?: string }>(tokenRow.value).v ?? ""
      : tokenRow.value;
  }
  const phoneNumberId = byKey.get("whatsapp_phone_id")?.value ?? "";
  const configured = Boolean(token && phoneNumberId);

  const storedStatus = byKey.get("whatsapp_status")?.value ?? "";
  const checkedRaw = byKey.get("whatsapp_last_checked_at")?.value ?? "";
  const checkedMs = Date.parse(checkedRaw);

  const coreRows = CORE_KEYS.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  const updatedAt = coreRows.length
    ? new Date(Math.max(...coreRows.map((r) => r.updatedAt.getTime()))).toISOString()
    : null;

  return {
    configured,
    displayPhone: byKey.get("whatsapp_display_phone")?.value ?? "",
    phoneNumberId,
    wabaId: byKey.get("whatsapp_waba_id")?.value ?? "",
    tokenMasked: token ? maskSecret(token) : "",
    status: configured && storedStatus === "connected" ? "connected" : "disconnected",
    lastCheckedAt: Number.isNaN(checkedMs) ? null : new Date(checkedMs).toISOString(),
    updatedAt,
  };
}

async function getStoredToken(): Promise<string> {
  const rows = await db.platformSetting.findMany({ where: { key: "whatsapp_token" }, take: 1 });
  const row = rows[0];
  if (!row) return "";
  return row.encrypted ? decryptJSON<{ v?: string }>(row.value).v ?? "" : row.value;
}

async function getStoredPhoneId(): Promise<string> {
  const rows = await db.platformSetting.findMany({ where: { key: "whatsapp_phone_id" }, take: 1 });
  return rows[0]?.value ?? "";
}

/** Live check against Meta Graph v18.0 with an 8s timeout. Never echoes the token. */
async function verifyWithMeta(phoneNumberId: string, token: string): Promise<{ ok: boolean; message: string }> {
  const redact = (msg: string) => (token ? msg.split(token).join("[redacted]") : msg);
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}?access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      display_phone_number?: string;
      error?: { message?: string };
    };
    if (res.ok && data.id) {
      return {
        ok: true,
        message: `Meta verified the connection${data.display_phone_number ? ` for +${data.display_phone_number}` : ""} — the platform WhatsApp number is live.`,
      };
    }
    return { ok: false, message: redact(data.error?.message ?? `Meta API responded with ${res.status}.`) };
  } catch {
    return {
      ok: false,
      message:
        "Verification pending — credentials are saved, but the server could not reach graph.facebook.com right now. Retry the test from a network with Meta access.",
    };
  }
}

/** GET /api/owner/whatsapp — current platform WhatsApp config (token masked). */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  return NextResponse.json(await loadPlatformWhatsappState());
}

/** PUT /api/owner/whatsapp — save platform credentials (token encrypted at rest). */
export async function PUT(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => ({}));
  const displayPhone = String(body.displayPhone ?? "").trim();
  const phoneNumberId = String(body.phoneNumberId ?? "").trim();
  const wabaId = String(body.wabaId ?? "").trim();
  const accessToken = String(body.accessToken ?? "").trim(); // blank = keep saved token

  if (!phoneNumberId) {
    return NextResponse.json({ error: "Phone Number ID is required" }, { status: 400 });
  }

  const storedToken = await getStoredToken();
  if (!accessToken && !storedToken) {
    return NextResponse.json({ error: "Access token is required" }, { status: 400 });
  }

  const token = accessToken || storedToken;
  await setPlatformSetting("whatsapp_token", encryptJSON({ v: token }), { encrypted: true, updatedBy: owner.email });
  await setPlatformSetting("whatsapp_phone_id", phoneNumberId, { updatedBy: owner.email });
  await setPlatformSetting("whatsapp_waba_id", wabaId, { updatedBy: owner.email });
  await setPlatformSetting("whatsapp_display_phone", displayPhone, { updatedBy: owner.email });
  // A credential save resets the verified state until the next live test passes.
  await setPlatformSetting("whatsapp_status", "disconnected", { updatedBy: owner.email });

  await logPlatformAction({
    actorId: owner.sub,
    actorName: owner.email,
    action: "WHATSAPP_PLATFORM_CONFIG",
    entity: "platform_setting",
    entityId: "whatsapp_token",
    details: `Platform WhatsApp Cloud API credentials saved (phone number ID ${phoneNumberId}${wabaId ? `, WABA ${wabaId}` : ""})`,
  });

  return NextResponse.json({ ok: true, ...(await loadPlatformWhatsappState()) });
}

/** POST /api/owner/whatsapp — { action: "test" } live-verifies against the Meta Graph API. */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => ({}));
  if (String(body.action ?? "") !== "test") {
    return NextResponse.json({ error: "Unknown action — use { action: 'test' }" }, { status: 400 });
  }

  const [token, phoneNumberId] = await Promise.all([getStoredToken(), getStoredPhoneId()]);
  if (!token || !phoneNumberId) {
    return NextResponse.json(
      { error: "Save the Phone Number ID and Access Token first, then test the connection." },
      { status: 400 }
    );
  }

  const result = await verifyWithMeta(phoneNumberId, token);

  await setPlatformSetting("whatsapp_status", result.ok ? "connected" : "error", { updatedBy: owner.email });
  await setPlatformSetting("whatsapp_last_checked_at", new Date().toISOString(), { updatedBy: owner.email });
  await logPlatformAction({
    actorId: owner.sub,
    actorName: owner.email,
    action: result.ok ? "WHATSAPP_PLATFORM_TEST_OK" : "WHATSAPP_PLATFORM_TEST_FAILED",
    entity: "platform_setting",
    entityId: "whatsapp_token",
    details: result.message,
  });

  return NextResponse.json({ ok: result.ok, message: result.message });
}
