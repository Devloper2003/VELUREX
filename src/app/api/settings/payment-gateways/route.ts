import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptJSON, maskSecret } from "@/lib/crypto";
import { GATEWAY_PROVIDERS, ONLINE_PROVIDERS, gatewayCreds } from "@/lib/payment-gateways";

/**
 * Tenant self-service payment gateways.
 *
 * The TENANT links their own gateway account (their Razorpay / Stripe keys)
 * so every guest payment — POS settle, folio payment, booking widget, payment
 * links — is charged through the tenant's account and settles into the
 * tenant's own bank account. Secrets are encrypted at rest and NEVER returned
 * to the browser (only a masked hint).
 */

const MODES = ["test", "live"];
const PROVIDERS = Object.keys(GATEWAY_PROVIDERS);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function shape(g: {
  id: string; provider: string; label: string; mode: string; enabled: boolean; isDefault: boolean;
  merchantId: string; secret: string; notes: string; addedBy: string; createdAt: Date; updatedAt: Date;
}) {
  const c = gatewayCreds(g.secret, g.merchantId);
  return {
    id: g.id,
    provider: g.provider,
    providerLabel: GATEWAY_PROVIDERS[g.provider]?.label ?? g.provider,
    label: g.label,
    mode: g.mode,
    enabled: g.enabled,
    isDefault: g.isDefault,
    merchantId: g.merchantId,
    merchantHint: c.keyId ? maskSecret(c.keyId) : "",
    hasSecret: Boolean(c.keySecret),
    hasWebhookSecret: Boolean(c.webhookSecret),
    online: GATEWAY_PROVIDERS[g.provider]?.online ?? false,
    notes: g.notes,
    addedBy: g.addedBy,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** GET /api/settings/payment-gateways — this property's linked gateways (masked). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const gateways = await db.paymentGateway.findMany({
    where: { propertyId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({
    gateways: gateways.map(shape),
    providers: Object.entries(GATEWAY_PROVIDERS).map(([key, m]) => ({ key, ...m })),
    summary: {
      total: gateways.length,
      online: gateways.filter((g) => ONLINE_PROVIDERS.includes(g.provider) && g.enabled).length,
      live: gateways.filter((g) => g.mode === "live" && g.enabled).length,
    },
  });
}

/**
 * POST /api/settings/payment-gateways — link a new gateway.
 * body: { provider, label?, mode?, merchantId, keySecret?, webhookSecret?, notes?, enabled?, isDefault? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const provider = str(body.provider);
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }

  const property = await db.property.findFirst({ where: { id: propertyId, deletedAt: null }, select: { id: true } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const keyId = str(body.merchantId).slice(0, 190);
  const keySecret = str(body.keySecret).slice(0, 400);
  const webhookSecret = str(body.webhookSecret).slice(0, 200);

  if (GATEWAY_PROVIDERS[provider].online && keySecret && !keyId) {
    return NextResponse.json({ error: "The key/merchant id is required when a secret is provided" }, { status: 400 });
  }

  const mode = MODES.includes(str(body.mode)) ? str(body.mode) : "test";
  const isDefault = body.isDefault === true;
  const existing = await db.paymentGateway.count({ where: { propertyId } });

  const gateway = await db.$transaction(async (tx) => {
    if (isDefault || existing === 0) {
      await tx.paymentGateway.updateMany({ where: { propertyId }, data: { isDefault: false } });
    }
    return tx.paymentGateway.create({
      data: {
        propertyId,
        provider,
        label: str(body.label).slice(0, 80),
        mode,
        enabled: body.enabled !== false,
        isDefault: isDefault || existing === 0,
        merchantId: keyId,
        secret: keySecret || webhookSecret ? encryptJSON({ keySecret, webhookSecret }) : "",
        notes: str(body.notes).slice(0, 500),
        addedBy: auth.session.name,
      },
    });
  });

  return NextResponse.json({ gateway: shape(gateway) }, { status: 201 });
}
