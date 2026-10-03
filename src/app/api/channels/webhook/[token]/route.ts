import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * POST /api/channels/webhook/{linkToken} — the tenant's INBOUND webhook
 * endpoint. Shown in the channel card's "Link URLs" dialog; OTAs (or an
 * intermediary integration service) POST booking events here so reservations
 * made on the channel arrive instantly instead of waiting for the next poll.
 *
 * Public but token-authenticated (allow-listed in src/proxy.ts), like real
 * channel webhooks. Every accepted event is written to the Channel Sync Log
 * so the tenant can see exactly what the channel delivered.
 *
 * Event shape (flexible on purpose — channels differ):
 *   { "type": "booking.created", "booking": { … }, … }
 *   { "event": "booking.cancelled", … }
 */

const MAX_BODY_BYTES = 64 * 1024;

async function handle(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const conn = await db.channelConnection.findUnique({ where: { linkToken: token } });
  if (!conn) {
    return NextResponse.json({ ok: false, error: "Unknown webhook token" }, { status: 404 });
  }

  if (req.method === "GET") {
    // Convenience probe so a tenant can paste the URL in a browser and see the
    // endpoint is live.
    return NextResponse.json({
      ok: true,
      channel: conn.channel,
      endpoint: "webhook",
      hint: 'POST JSON events here, e.g. {"type":"booking.created","booking":{"ref":"ABC123","checkIn":"2026-11-05","checkOut":"2026-11-07","roomType":" Deluxe King"}}',
      paused: !conn.isActive,
    });
  }

  if (!conn.isActive) {
    return NextResponse.json({ ok: false, error: "Channel is paused — events are not being processed" }, { status: 409 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON" }, { status: 400 });
  }

  const type = String(payload.type ?? payload.event ?? "unknown");
  const booking = (payload.booking ?? payload.data ?? null) as Record<string, unknown> | null;
  const ref = booking && typeof booking.ref === "string" ? booking.ref
    : booking && typeof booking.confirmationNumber === "string" ? booking.confirmationNumber : "";
  const summary = ref ? `${type} — ref ${ref}` : type;

  await db.channelSyncLog.create({
    data: {
      propertyId: conn.propertyId,
      channelConnectionId: conn.id,
      channel: conn.channel,
      action: "webhook_event",
      status: "success",
      message: `Webhook received: ${summary}`,
    },
  });

  return NextResponse.json({ ok: true, received: type });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx);
}
