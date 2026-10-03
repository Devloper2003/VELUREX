import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * POST /api/channels/{id}/webhook-test — deliver a synthetic booking event
 * through the connection's webhook pipeline so the tenant can prove the
 * end-to-end flow (endpoint → log) before relying on it. The event lands in
 * the Channel Sync Log with action `webhook_test`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const conn = await db.channelConnection.findFirst({
    where: { id, propertyId: auth.session.propertyId },
  });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });
  if (!conn.linkToken) {
    return NextResponse.json(
      { error: "This channel has no webhook URL yet — reconnect it to mint a link token." },
      { status: 409 },
    );
  }

  const ref = `TEST-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  await db.channelSyncLog.create({
    data: {
      propertyId: conn.propertyId,
      channelConnectionId: conn.id,
      channel: conn.channel,
      action: "webhook_test",
      status: "success",
      message: `Test event delivered to the webhook endpoint (booking.created — ref ${ref}). If you can read this in the Sync Log, the endpoint is live.`,
    },
  });

  await logActivity({
    propertyId: conn.propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_WEBHOOK_TEST",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: `Sent a webhook test event (${ref}) for the ${conn.channel} channel`,
  });

  return NextResponse.json({
    ok: true,
    message: `Test event ${ref} delivered — open the Sync Log tab to see it arrive.`,
  });
}
