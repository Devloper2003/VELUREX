import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { testGatewayConnection } from "@/lib/payment-gateways";
import { handleRoute } from "@/lib/route-error";

/**
 * POST /api/settings/payment-gateways/[id]/test — tenant runs a real
 * authenticated round-trip against THEIR OWN gateway (Razorpay/Stripe live API
 * call from the server; manual providers get a credential-completeness check).
 * Returns { ok, message } — never throws to the client.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute("settings.gatewayTest", () => gatewayTest(req, { params }));
}

async function gatewayTest(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const g = await db.paymentGateway.findFirst({
    where: { id, propertyId: auth.session.propertyId },
  });
  if (!g) return NextResponse.json({ error: "Gateway not found" }, { status: 404 });

  // The helper decrypts internally and never throws — network/auth failures
  // come back as { ok: false, message } with precise remediation text.
  const result = await testGatewayConnection({
    provider: g.provider,
    merchantId: g.merchantId,
    secret: g.secret,
    mode: g.mode,
  });

  await logActivity({
    propertyId: auth.session.propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: result.ok ? "GATEWAY_TEST_OK" : "GATEWAY_TEST_FAILED",
    entity: "PaymentGateway",
    entityId: g.id,
    details: `${g.provider} (${g.mode}) — ${result.message}`,
  }).catch(() => {});

  return NextResponse.json(result);
}
