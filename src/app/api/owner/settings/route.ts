import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { maskSecret, decryptJSON } from "@/lib/crypto";
import { setPlatformSetting } from "@/lib/platform";

// Sensitive keys are AES-256-GCM encrypted at rest and NEVER returned in full
// after being saved — the GET response only exposes masked previews.
const SENSITIVE_KEYS = new Set([
  "razorpay_key_id", "razorpay_key_secret", "whatsapp_token", "smtp_pass",
]);

// Keys the UI shows grouped
export const SETTING_GROUPS: Record<string, string[]> = {
  billing: ["default_trial_days", "grace_days", "suspend_retention_days", "yearly_discount_percent", "quarterly_discount_percent", "gst_rate", "company_name", "company_gstin"],
  integrations: ["razorpay_key_id", "razorpay_key_secret", "whatsapp_phone_id", "whatsapp_token", "smtp_host", "smtp_user", "smtp_pass"],
  templates: ["tmpl_welcome_email", "tmpl_welcome_whatsapp", "tmpl_booking_confirmation", "tmpl_pre_arrival"],
  legal: ["terms_url", "privacy_url"],
};

/** GET /api/owner/settings — grouped settings; sensitive values masked. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const rows = await db.platformSetting.findMany({ orderBy: { key: "asc" } });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const groups = Object.entries(SETTING_GROUPS).map(([group, keys]) => ({
    group,
    settings: keys.map((key) => {
      const row = byKey.get(key);
      const sensitive = SENSITIVE_KEYS.has(key);
      let preview = "";
      if (row) {
        if (row.encrypted) {
          // Masked preview of the decrypted value's tail — full value never leaves the server.
          const plain = decryptJSON<{ v?: string }>(row.value).v ?? "";
          preview = plain ? `••••••••••${plain.slice(-4)}` : "••••••••••";
        } else {
          preview = row.value.length > 60 ? `${row.value.slice(0, 60)}…` : row.value;
        }
      }
      return {
        key,
        configured: !!row,
        sensitive,
        preview,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    }),
  }));

  return NextResponse.json({ groups });
}

/** POST /api/owner/settings — save values (sensitive keys encrypted at rest). */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => ({}));
  const entries = Object.entries(body as Record<string, unknown>).filter(([k]) => k.length < 64);
  if (entries.length === 0) return NextResponse.json({ error: "No settings provided" }, { status: 400 });

  let saved = 0;
  for (const [key, raw] of entries) {
    const value = String(raw ?? "");
    if (!value && !SENSITIVE_KEYS.has(key)) continue;
    const encrypted = SENSITIVE_KEYS.has(key);
    // For sensitive keys, an empty/unchanged masked submission keeps the stored value.
    if (encrypted && (value.includes("••") || value === "")) continue;
    await setPlatformSetting(key, value, { encrypted, updatedBy: owner.email });
    saved++;
  }

  return NextResponse.json({ ok: true, saved });
}
