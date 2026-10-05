import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import {
  getKotBroadcastConfig,
  saveKotBroadcastConfig,
  resolveKotRecipients,
} from "@/lib/kot-broadcast";

/**
 * KOT WhatsApp broadcast settings (Settings → WhatsApp API → KOT broadcast).
 *   GET  → config + how many owner numbers are picked up automatically
 *   PUT  → hotel_admin saves { enabled, format, phones[] }
 * Config is stored inside WhatsAppConfig.automationJson (key "kot_broadcast")
 * — no schema change, template switches round-trip untouched.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId } = auth.session;

  const cfg = await getKotBroadcastConfig(propertyId);
  const ownerRecipients = await resolveKotRecipients(propertyId, []);

  return NextResponse.json({
    config: cfg,
    ownerRecipients: ownerRecipients.length,
    preview: {
      caption: "KOT 1042 · Table T12 · 3 items · ₹570.00 — Your Hotel",
      text: [
        "🍳 *KOT 1042* — new order received",
        `*Your Hotel*`,
        "📍 Table T12 · Dine-in",
        "🕒 5:42 PM · 05 Oct 2026",
        "──────────────",
        "• *2×* Dal Makhani",
        "   ↳ _less spicy_",
        "• *1×* Butter Naan",
        "──────────────",
        "Items: 3 · *₹570.00* incl. GST",
        "_Sent via Velurex HMS_",
      ].join("\n"),
    },
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const enabled = Boolean(body.enabled);
  const format = body.format === "text" ? "text" : "image";
  const phones = Array.isArray(body.phones)
    ? body.phones
        .map((p) => String(p).trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  // Sanity: numbers must look phone-ish (digits, spaces, +, -, parens) — never executed, only sent to.
  const bad = phones.find((p) => !/^[0-9+\-\s()]{5,20}$/.test(p));
  if (bad) {
    return NextResponse.json({ error: `"${bad}" does not look like a phone number` }, { status: 400 });
  }

  const saved = await saveKotBroadcastConfig(propertyId, { enabled, format, phones });
  const ownerRecipients = await resolveKotRecipients(propertyId, []);

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "KOT_BROADCAST_SAVED",
    entity: "whatsapp_config",
    entityId: propertyId,
    details: `KOT broadcast ${enabled ? "enabled" : "disabled"} · format ${saved.format} · ${saved.phones.length} group number(s) · ${ownerRecipients.length} owner number(s)`,
  });

  return NextResponse.json({ ok: true, config: saved, ownerRecipients: ownerRecipients.length });
}
