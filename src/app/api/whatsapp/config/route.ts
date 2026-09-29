import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { encryptJSON, maskSecret, decryptJSON } from "@/lib/crypto";
import { randomBytes } from "crypto";

/**
 * Per-tenant WhatsApp Cloud API self-service connection.
 *   GET /api/whatsapp/config  → masked config + webhook URL + effective provider
 *   PUT /api/whatsapp/config  → hotel_admin saves credentials (token encrypted at
 *                               rest, NEVER returned in full — only a masked hint)
 */

function webhookUrlFrom(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/api/whatsapp/webhook`;
}

function genVerifyToken(): string {
  return `vx_${randomBytes(12).toString("hex")}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { propertyId } = auth.session;

  const cfg = await db.whatsAppConfig.findUnique({ where: { propertyId } });
  let tokenHint = "";
  if (cfg?.accessTokenEnc) {
    const secret = decryptJSON<{ token?: string }>(cfg.accessTokenEnc);
    tokenHint = maskSecret(secret.token ?? "");
  }

  const envSet = Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
  const provider = cfg?.status === "connected" ? "tenant" : envSet ? "platform" : "mock";

  return NextResponse.json({
    config: {
      displayPhone: cfg?.displayPhone ?? "",
      phoneNumberId: cfg?.phoneNumberId ?? "",
      wabaId: cfg?.wabaId ?? "",
      hasToken: Boolean(cfg?.accessTokenEnc),
      tokenHint,
      verifyToken: cfg?.verifyToken ?? "",
      status: cfg?.status ?? "disconnected",
      lastError: cfg?.lastError ?? "",
      lastCheckedAt: cfg?.lastCheckedAt ?? null,
      connectedAt: cfg?.connectedAt ?? null,
    },
    provider,
    webhookUrl: webhookUrlFrom(req),
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  const body = await req.json().catch(() => ({}));
  const displayPhone = String(body.displayPhone ?? "").trim();
  const phoneNumberId = String(body.phoneNumberId ?? "").trim();
  const wabaId = String(body.wabaId ?? "").trim();
  const accessToken = String(body.accessToken ?? "").trim(); // blank = keep saved token
  const verifyToken = String(body.verifyToken ?? "").trim();

  const existing = await db.whatsAppConfig.findUnique({ where: { propertyId } });

  // Any credential change resets the connection state until "Test connection" passes.
  const payload: Record<string, unknown> = {
    displayPhone,
    phoneNumberId,
    wabaId,
    verifyToken: verifyToken || existing?.verifyToken || genVerifyToken(),
    status: "disconnected",
    lastError: "",
  };
  if (accessToken) payload.accessTokenEnc = encryptJSON({ token: accessToken });

  const cfg = await db.whatsAppConfig.upsert({
    where: { propertyId },
    update: payload,
    create: { propertyId, ...(payload as { displayPhone: string; phoneNumberId: string; wabaId: string; verifyToken: string; status: string; lastError: string }) },
  });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "WHATSAPP_CONFIG_SAVED",
    entity: "whatsapp_config",
    entityId: cfg.id,
    details: `WhatsApp Cloud API credentials saved (phone number ID ${phoneNumberId || "—"})`,
  });

  return NextResponse.json({ ok: true, id: cfg.id, verifyToken: cfg.verifyToken });
}
