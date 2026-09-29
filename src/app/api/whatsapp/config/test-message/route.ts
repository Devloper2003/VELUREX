import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { sendWhatsApp } from "@/lib/whatsapp";

/**
 * POST /api/whatsapp/config/test-message — hotel_admin sends a plain text
 * WhatsApp message to any phone number to prove the connection end-to-end.
 * Uses the tenant's own Cloud API credentials when connected, else the
 * platform fallback (env), else logs a "mock" message.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, name: staffName } = auth.session;

  const body = await req.json().catch(() => ({}));
  const toPhone = String(body.phone ?? "").trim();
  if (!toPhone) return NextResponse.json({ error: "A phone number is required" }, { status: 400 });

  const message = await sendWhatsApp({
    propertyId,
    toPhone,
    templateName: "custom",
    body: `✅ Test message from ${staffName} via Velurex HMS — your WhatsApp Cloud API connection is working.`,
  });

  return NextResponse.json({
    ok: message.status !== "failed",
    status: message.status,
    providerId: message.providerId,
    messageId: message.id,
  });
}
