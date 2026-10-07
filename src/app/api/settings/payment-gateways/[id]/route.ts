import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptJSON } from "@/lib/crypto";
import { GATEWAY_PROVIDERS, gatewayCreds } from "@/lib/payment-gateways";

/**
 * PATCH  /api/settings/payment-gateways/[id] — tenant edits THEIR OWN gateway.
 * DELETE /api/settings/payment-gateways/[id] — tenant unlinks it.
 *
 * Empty keySecret/webhookSecret on PATCH = keep the stored ones.
 */

const MODES = ["test", "live"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function ownGateway(req: NextRequest, id: string) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return { error: auth.error } as const;
  const g = await db.paymentGateway.findFirst({
    where: { id, propertyId: auth.session.propertyId },
  });
  if (!g) return { error: NextResponse.json({ error: "Gateway not found" }, { status: 404 }) } as const;
  return { auth, g } as const;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await ownGateway(req, id);
  if ("error" in found) return found.error;
  const { auth, g } = found;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const provider = str(body.provider) || g.provider;
  if (!GATEWAY_PROVIDERS[provider]) {
    return NextResponse.json({ error: `provider must be one of: ${Object.keys(GATEWAY_PROVIDERS).join(", ")}` }, { status: 400 });
  }

  const existing = gatewayCreds(g.secret, g.merchantId);
  const keyId = body.merchantId !== undefined ? str(body.merchantId).slice(0, 190) : existing.keyId;
  const keySecret = body.keySecret !== undefined && str(body.keySecret) !== "" ? str(body.keySecret).slice(0, 400) : existing.keySecret;
  const webhookSecret =
    body.webhookSecret !== undefined && str(body.webhookSecret) !== "" ? str(body.webhookSecret).slice(0, 200) : existing.webhookSecret;

  const mode = MODES.includes(str(body.mode)) ? str(body.mode) : g.mode;
  const enabled = body.enabled === undefined ? g.enabled : body.enabled === true;
  const isDefault = body.isDefault === true;

  const updated = await db.$transaction(async (tx) => {
    if (isDefault && !g.isDefault) {
      await tx.paymentGateway.updateMany({ where: { propertyId: g.propertyId }, data: { isDefault: false } });
    }
    return tx.paymentGateway.update({
      where: { id: g.id },
      data: {
        provider,
        label: body.label !== undefined ? str(body.label).slice(0, 80) : g.label,
        mode,
        enabled,
        isDefault: isDefault || g.isDefault,
        merchantId: keyId,
        secret: keySecret || webhookSecret ? encryptJSON({ keySecret, webhookSecret }) : "",
        notes: body.notes !== undefined ? str(body.notes).slice(0, 500) : g.notes,
      },
    });
  });

  return NextResponse.json({
    gateway: {
      id: updated.id,
      provider: updated.provider,
      label: updated.label,
      mode: updated.mode,
      enabled: updated.enabled,
      isDefault: updated.isDefault,
      merchantId: updated.merchantId,
      hasSecret: Boolean(keySecret),
      hasWebhookSecret: Boolean(webhookSecret),
      updatedAt: updated.updatedAt,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await ownGateway(req, id);
  if ("error" in found) return found.error;
  const { g } = found;

  const pending = await db.payment.count({ where: { gatewayId: g.id, status: "pending" } });
  if (pending > 0) {
    return NextResponse.json(
      { error: `${pending} pending online payment(s) still reference this gateway — wait for them to settle or fail first.` },
      { status: 409 }
    );
  }

  await db.paymentGateway.delete({ where: { id: g.id } });
  return NextResponse.json({ ok: true });
}
