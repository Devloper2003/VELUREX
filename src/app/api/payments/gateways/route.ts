import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/payments/gateways — the online payment gateways the platform owner
 * has assigned to THIS property (enabled only). Secrets never leave the
 * server; the tenant only gets display fields. POS settle and folio payment
 * dialogs use this list to offer "Pay via <gateway>".
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const gateways = await db.paymentGateway.findMany({
    where: { propertyId, enabled: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({
    gateways: gateways.map((g) => ({
      id: g.id,
      provider: g.provider,
      label: g.label,
      mode: g.mode,
      isDefault: g.isDefault,
    })),
  });
}
