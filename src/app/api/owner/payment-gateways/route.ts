import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";
import { encryptJSON } from "@/lib/crypto";

/**
 * Payment gateways — the software owner assigns online payment providers to
 * tenant properties. The tenant can see and USE the gateway (POS settle,
 * folio payments) but never edits or reads its secrets.
 */

const PROVIDERS = ["razorpay", "cashfree", "payu", "paytm", "phonepe", "stripe", "upi_qr", "bank_transfer", "custom"];
const MODES = ["test", "live"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** GET /api/owner/payment-gateways — every tenant's gateway configs (secrets masked). */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const gateways = await db.paymentGateway.findMany({
    where: notDemoTenant(scope),
    include: {
      property: {
        select: { id: true, name: true, city: true, state: true, subscriptionStatus: true, currentPlanId: true },
      },
    },
    orderBy: [{ propertyId: "asc" }, { createdAt: "desc" }],
  });

  const properties = await db.property.findMany({
    where: notDemoTenantId(scope),
    select: { id: true, name: true, city: true, state: true, subscriptionStatus: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    gateways: gateways.map((g) => ({
      id: g.id,
      propertyId: g.propertyId,
      provider: g.provider,
      label: g.label,
      mode: g.mode,
      enabled: g.enabled,
      isDefault: g.isDefault,
      merchantId: g.merchantId,
      hasSecret: Boolean(g.secret),
      notes: g.notes,
      addedBy: g.addedBy,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      property: g.property,
    })),
    properties,
    summary: {
      total: gateways.length,
      enabled: gateways.filter((g) => g.enabled).length,
      live: gateways.filter((g) => g.mode === "live").length,
      tenantsConfigured: new Set(gateways.map((g) => g.propertyId)).size,
    },
  });
}

/**
 * POST /api/owner/payment-gateways — assign a gateway to a tenant.
 * body: { propertyId, provider, label?, mode?, enabled?, isDefault?, merchantId?, secret?, notes? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const propertyId = str(body.propertyId);
  const provider = str(body.provider);
  if (!propertyId) return NextResponse.json({ error: "propertyId is required" }, { status: 400 });
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }

  const property = await db.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: { id: true, name: true, isDemo: true },
  });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  // Guard: never store real credentials on a demo tenant.
  if (property.isDemo && str(body.secret)) {
    return NextResponse.json(
      { error: "Refusing to store a real secret on a demo tenant — leave the secret empty for demo/test setups" },
      { status: 400 }
    );
  }

  const mode = MODES.includes(str(body.mode)) ? str(body.mode) : "test";
  const isDefault = body.isDefault === true;

  const gateway = await db.$transaction(async (tx) => {
    if (isDefault) {
      await tx.paymentGateway.updateMany({ where: { propertyId }, data: { isDefault: false } });
    }
    return tx.paymentGateway.create({
      data: {
        propertyId,
        provider,
        label: str(body.label).slice(0, 80),
        mode,
        enabled: body.enabled !== false,
        isDefault,
        merchantId: str(body.merchantId).slice(0, 190),
        secret: str(body.secret) ? encryptJSON({ secret: str(body.secret) }) : "",
        notes: str(body.notes).slice(0, 500),
        addedBy: auth.session.name,
      },
    });
  });

  return NextResponse.json(
    {
      gateway: {
        id: gateway.id,
        propertyId: gateway.propertyId,
        provider: gateway.provider,
        label: gateway.label,
        mode: gateway.mode,
        enabled: gateway.enabled,
        isDefault: gateway.isDefault,
        merchantId: gateway.merchantId,
        hasSecret: Boolean(gateway.secret),
        createdAt: gateway.createdAt,
      },
    },
    { status: 201 }
  );
}
