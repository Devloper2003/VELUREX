import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * POST /api/whatsapp/config/disconnect — hotel_admin clears the stored access
 * token and marks the tenant disconnected. All other fields are kept so the
 * tenant can re-connect without retyping IDs. Tenant data is never deleted.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  const existing = await db.whatsAppConfig.findUnique({ where: { propertyId } });
  if (!existing) return NextResponse.json({ ok: true });

  const updated = await db.whatsAppConfig.update({
    where: { propertyId },
    data: { accessTokenEnc: "", status: "disconnected", lastError: "", connectedAt: null },
  });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "WHATSAPP_DISCONNECTED",
    entity: "whatsapp_config",
    entityId: updated.id,
    details: "WhatsApp Cloud API disconnected by hotel admin",
  });

  return NextResponse.json({ ok: true });
}
