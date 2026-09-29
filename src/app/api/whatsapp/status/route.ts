import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/whatsapp/status — provider mode for the header badge:
 *   "cloud_api" when the tenant connected its own WhatsApp Cloud API
 *               (source: "tenant") or the platform env is configured
 *               (source: "platform"),
 *   "mock"      otherwise (simulation mode).
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { propertyId } = auth.session;

  const cfg = await db.whatsAppConfig.findUnique({ where: { propertyId } });
  if (cfg?.status === "connected" && cfg.phoneNumberId && cfg.accessTokenEnc) {
    return NextResponse.json({
      provider: "cloud_api",
      source: "tenant",
      phoneIdSet: true,
      fromNumber: cfg.displayPhone || cfg.phoneNumberId,
    });
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  return NextResponse.json({
    provider: token && phoneId ? "cloud_api" : "mock",
    source: token && phoneId ? "platform" : "none",
    phoneIdSet: Boolean(phoneId),
    fromNumber: phoneId ?? "",
  });
}
