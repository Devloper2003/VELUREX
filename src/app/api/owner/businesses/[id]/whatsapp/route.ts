import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { decryptJSON, encryptJSON, maskSecret } from "@/lib/crypto";
import { logPlatformAction } from "@/lib/platform";

/**
 * Owner configures a TENANT's WhatsApp Cloud API on the business's behalf
 * (same WhatsAppConfig row the tenant self-service flow uses, so both stay in
 * sync). Follows the exact conventions of /api/whatsapp/config*:
 *   - accessTokenEnc stores encryptJSON({token}) — never returned in full
 *   - verifyToken is the webhook pairing token (intentionally visible)
 *   - webhook handshake happens at /api/whatsapp/webhook (GET,POST)
 */

type Params = { params: Promise<{ id: string }> };

function genVerifyToken(): string {
  return `vx_${randomBytes(12).toString("hex")}`;
}

async function loadConfigState(propertyId: string) {
  const cfg = await db.whatsAppConfig.findUnique({ where: { propertyId } });
  let tokenMasked = "";
  if (cfg?.accessTokenEnc) {
    const secret = decryptJSON<{ token?: string }>(cfg.accessTokenEnc);
    tokenMasked = maskSecret(secret.token ?? "");
  }
  return {
    cfg,
    response: {
      config: {
        displayPhone: cfg?.displayPhone ?? "",
        phoneNumberId: cfg?.phoneNumberId ?? "",
        wabaId: cfg?.wabaId ?? "",
        status: cfg?.status ?? "disconnected",
        lastError: cfg?.lastError ?? "",
        lastCheckedAt: cfg?.lastCheckedAt ?? null,
        connectedAt: cfg?.connectedAt ?? null,
        tokenMasked,
        verifyToken: cfg?.verifyToken ?? "",
      },
    },
  };
}

/** GET /api/owner/businesses/[id]/whatsapp — tenant WhatsApp config + webhook pairing info. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const property = await db.property.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

  const { response } = await loadConfigState(id);
  return NextResponse.json({
    business: { id: property.id, name: property.name },
    ...response,
    webhookUrl: "/api/whatsapp/webhook",
    webhookMethod: "GET,POST",
  });
}

/**
 * PUT /api/owner/businesses/[id]/whatsapp — owner actions:
 *   save (default)  upsert credentials; status "connected" when phoneNumberId
 *                   + token are present, else "disconnected"
 *   disconnect      clear the stored token, keep IDs (mirrors tenant self-service)
 *   test            live-verify the stored token against the Meta Graph API
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const property = await db.property.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "save");

  const audit = async (details: string) =>
    logPlatformAction({
      actorId: owner.sub,
      actorName: owner.email,
      action: "WHATSAPP_TENANT_CONFIG",
      entity: "whatsapp_config",
      entityId: id,
      propertyId: id,
      details,
    });

  // ── disconnect ────────────────────────────────────────────────────────────
  if (action === "disconnect") {
    const existing = await db.whatsAppConfig.findUnique({ where: { propertyId: id } });
    if (existing) {
      await db.whatsAppConfig.update({
        where: { propertyId: id },
        data: { accessTokenEnc: "", status: "disconnected", lastError: "", connectedAt: null },
      });
    }
    await audit(`WhatsApp Cloud API disconnected by owner for ${property.name} — IDs kept, token cleared`);
    const { response } = await loadConfigState(id);
    return NextResponse.json({ ok: true, ...response, webhookUrl: "/api/whatsapp/webhook", webhookMethod: "GET,POST" });
  }

  // ── test (live check with the stored tenant token) ────────────────────────
  if (action === "test") {
    const cfg = await db.whatsAppConfig.findUnique({ where: { propertyId: id } });
    if (!cfg || !cfg.phoneNumberId || !cfg.accessTokenEnc) {
      return NextResponse.json(
        { error: "Save this business's Phone Number ID and Access Token first, then test the connection." },
        { status: 400 }
      );
    }
    const token = decryptJSON<{ token?: string }>(cfg.accessTokenEnc).token ?? "";
    if (!token) {
      return NextResponse.json({ error: "Saved access token could not be read — please re-enter it." }, { status: 400 });
    }

    let ok = false;
    let message = "";
    let displayPhone = cfg.displayPhone;
    let wabaId = cfg.wabaId;
    const redact = (msg: string) => (token ? msg.split(token).join("[redacted]") : msg);
    try {
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${cfg.phoneNumberId}?access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        display_phone_number?: string;
        whatsapp_business_account?: { id?: string };
        error?: { message?: string };
      };
      if (res.ok && data.id) {
        ok = true;
        if (data.display_phone_number) displayPhone = String(data.display_phone_number);
        if (data.whatsapp_business_account?.id) wabaId = String(data.whatsapp_business_account.id);
        message = `Meta verified the connection${data.display_phone_number ? ` for +${data.display_phone_number}` : ""} — ${property.name}'s WhatsApp number is live.`;
      } else {
        message = redact(data.error?.message ?? `Meta API responded with ${res.status}.`);
      }
    } catch {
      message =
        "Verification pending — credentials are saved, but the server could not reach graph.facebook.com right now. Retry the test from a network with Meta access.";
    }

    await db.whatsAppConfig.update({
      where: { propertyId: id },
      data: {
        status: ok ? "connected" : "error",
        lastError: ok ? "" : message,
        lastCheckedAt: new Date(),
        connectedAt: ok ? (cfg.connectedAt ?? new Date()) : cfg.connectedAt,
        displayPhone: displayPhone || cfg.displayPhone,
        wabaId: wabaId || cfg.wabaId,
      },
    });
    await audit(ok ? `WhatsApp test passed for ${property.name} (phone number ID ${cfg.phoneNumberId})` : `WhatsApp test failed for ${property.name}: ${message}`);

    const { response } = await loadConfigState(id);
    return NextResponse.json({
      ok,
      test: { ok, message },
      ...response,
      webhookUrl: "/api/whatsapp/webhook",
      webhookMethod: "GET,POST",
    });
  }

  // ── save (default) ────────────────────────────────────────────────────────
  if (action !== "save") {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  const displayPhone = String(body.displayPhone ?? "").trim();
  const phoneNumberId = String(body.phoneNumberId ?? "").trim();
  const wabaId = String(body.wabaId ?? "").trim();
  const accessToken = String(body.accessToken ?? "").trim(); // blank = keep saved token
  const verifyToken = String(body.verifyToken ?? "").trim();

  const existing = await db.whatsAppConfig.findUnique({ where: { propertyId: id } });
  const existingToken = decryptJSON<{ token?: string }>(existing?.accessTokenEnc ?? "").token ?? "";
  const nextToken = accessToken || existingToken;
  const connected = Boolean(phoneNumberId && nextToken);
  const wasConnected = existing?.status === "connected";

  const cfg = await db.whatsAppConfig.upsert({
    where: { propertyId: id },
    update: {
      displayPhone,
      phoneNumberId,
      wabaId,
      verifyToken: verifyToken || existing?.verifyToken || genVerifyToken(),
      ...(accessToken ? { accessTokenEnc: encryptJSON({ token: accessToken }) } : {}),
      status: connected ? "connected" : "disconnected",
      lastError: "",
      connectedAt: connected && !wasConnected ? new Date() : existing?.connectedAt ?? null,
    },
    create: {
      propertyId: id,
      displayPhone,
      phoneNumberId,
      wabaId,
      verifyToken: verifyToken || genVerifyToken(),
      ...(accessToken ? { accessTokenEnc: encryptJSON({ token: accessToken }) } : {}),
      status: connected ? "connected" : "disconnected",
      lastError: "",
      connectedAt: connected ? new Date() : null,
    },
  });

  await audit(
    `WhatsApp Cloud API credentials saved by owner for ${property.name} (phone number ID ${phoneNumberId || "—"}${connected ? ", marked connected" : ""})`
  );

  const { response } = await loadConfigState(id);
  return NextResponse.json({
    ok: true,
    ...response,
    webhookUrl: "/api/whatsapp/webhook",
    webhookMethod: "GET,POST",
  });
}
