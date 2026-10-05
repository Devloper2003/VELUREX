import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { encryptJSON } from "@/lib/crypto";

/**
 * PATCH  /api/owner/payment-gateways/[id] — update a tenant's gateway config.
 * DELETE /api/owner/payment-gateways/[id] — remove the assignment.
 *
 * A PATCH with `secret: ""` (empty string) keeps the stored secret unchanged;
 * `secret` absent is also "keep"; a non-empty value re-encrypts.
 */

const PROVIDERS = ["razorpay", "cashfree", "payu", "paytm", "phonepe", "stripe", "upi_qr", "bank_transfer", "custom"];
const MODES = ["test", "live"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const existing = await db.paymentGateway.findUnique({ where: { id }, select: { id: true, propertyId: true } });
  if (!existing) return NextResponse.json({ error: "Gateway not found" }, { status: 404 });

  const data: {
    provider?: string;
    label?: string;
    mode?: string;
    enabled?: boolean;
    isDefault?: boolean;
    merchantId?: string;
    secret?: string;
    notes?: string;
  } = {};

  if (typeof body.provider === "string") {
    const provider = str(body.provider);
    if (!PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
    }
    data.provider = provider;
  }
  if (typeof body.label === "string") data.label = str(body.label).slice(0, 80);
  if (typeof body.mode === "string") {
    const mode = str(body.mode);
    if (!MODES.includes(mode)) return NextResponse.json({ error: "mode must be test or live" }, { status: 400 });
    data.mode = mode;
  }
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.merchantId === "string") data.merchantId = str(body.merchantId).slice(0, 190);
  if (typeof body.notes === "string") data.notes = str(body.notes).slice(0, 500);
  if (typeof body.secret === "string" && str(body.secret)) {
    data.secret = encryptJSON({ secret: str(body.secret) });
  }

  const gateway = await db.$transaction(async (tx) => {
    if (body.isDefault === true) {
      await tx.paymentGateway.updateMany({
        where: { propertyId: existing.propertyId, id: { not: existing.id } },
        data: { isDefault: false },
      });
      data.isDefault = true;
    } else if (body.isDefault === false) {
      data.isDefault = false;
    }
    return tx.paymentGateway.update({ where: { id: existing.id }, data });
  });

  return NextResponse.json({
    gateway: {
      id: gateway.id,
      provider: gateway.provider,
      label: gateway.label,
      mode: gateway.mode,
      enabled: gateway.enabled,
      isDefault: gateway.isDefault,
      merchantId: gateway.merchantId,
      hasSecret: Boolean(gateway.secret),
      notes: gateway.notes,
      updatedAt: gateway.updatedAt,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const existing = await db.paymentGateway.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Gateway not found" }, { status: 404 });

  await db.paymentGateway.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
